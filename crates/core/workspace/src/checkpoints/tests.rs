use std::collections::BTreeMap;

use super::*;

fn captured(outcome: SnapshotOutcome) -> Snapshot {
    match outcome {
        SnapshotOutcome::Captured(snapshot) => snapshot,
        SnapshotOutcome::Skipped(reason) => panic!("snapshot skipped: {reason:?}"),
    }
}

/// One non-directory entry in a folder, as a rewind must reproduce it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    File { bytes: Vec<u8>, executable: bool },
    Symlink(PathBuf),
}

/// Every file and symlink under `root` (directories are implied), excluding
/// the user's own `.git`.
fn tree(root: &Path) -> BTreeMap<PathBuf, Node> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Node>) {
        let mut entries = std::fs::read_dir(dir)
            .expect("read dir")
            .map(|entry| entry.expect("dir entry").path())
            .collect::<Vec<_>>();
        entries.sort();
        for path in entries {
            let relative = path.strip_prefix(root).expect("relative").to_path_buf();
            if relative == Path::new(".git") {
                continue;
            }
            let meta = std::fs::symlink_metadata(&path).expect("metadata");
            if meta.file_type().is_symlink() {
                out.insert(
                    relative,
                    Node::Symlink(std::fs::read_link(&path).expect("link")),
                );
            } else if meta.is_dir() {
                walk(root, &path, out);
            } else {
                out.insert(
                    relative,
                    Node::File {
                        bytes: std::fs::read(&path).expect("read"),
                        executable: is_executable(&meta),
                    },
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn set_executable(path: &Path, executable: bool) {
    use std::os::unix::fs::PermissionsExt as _;
    let mut permissions = std::fs::metadata(path).expect("meta").permissions();
    permissions.set_mode(if executable { 0o755 } else { 0o644 });
    std::fs::set_permissions(path, permissions).expect("chmod");
}

fn write(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(path, bytes).expect("write");
}

fn read(root: &Path, relative: &str) -> Vec<u8> {
    std::fs::read(root.join(relative)).expect("read")
}

fn fixture() -> (tempfile::TempDir, tempfile::TempDir, WorkspaceCheckpoints) {
    let store = tempfile::tempdir().expect("store");
    let workspace = tempfile::tempdir().expect("workspace");
    let checkpoints = WorkspaceCheckpoints::new(store.path().to_path_buf());
    (store, workspace, checkpoints)
}

fn skipped_paths(report: &RestoreReport) -> Vec<(&str, SkippedReason)> {
    report
        .skipped
        .iter()
        .map(|skipped| (skipped.path.as_str(), skipped.reason))
        .collect()
}

#[test]
fn restore_reverts_edits_creations_and_deletions() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "keep.txt", b"original\n");
    write(root, "delete-me.txt", b"bye\n");
    write(root, ".gitignore", b"ignored.log\n");
    write(root, "ignored.log", b"before\n");

    let before = captured(checkpoints.snapshot(root, "turn 1").unwrap());
    let again = captured(checkpoints.snapshot(root, "turn 1 again").unwrap());
    assert_eq!(
        before.commit, again.commit,
        "unchanged folder reuses commit"
    );

    write(root, "keep.txt", b"edited\n");
    std::fs::remove_file(root.join("delete-me.txt")).unwrap();
    write(root, "new/nested/created.txt", b"new\n");
    write(root, "ignored.log", b"after\n");

    let mut changes = checkpoints.changes_since(root, &before.commit).unwrap();
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(
        changes,
        vec![
            FileChange {
                path: "delete-me.txt".into(),
                kind: FileChangeKind::Deleted
            },
            FileChange {
                path: "keep.txt".into(),
                kind: FileChangeKind::Modified
            },
            FileChange {
                path: "new/nested/created.txt".into(),
                kind: FileChangeKind::Added
            },
        ]
    );

    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(report.removed, vec!["new/nested/created.txt".to_owned()]);
    assert_eq!(report.restored.len(), 2);
    assert_eq!(read(root, "keep.txt"), b"original\n");
    assert_eq!(read(root, "delete-me.txt"), b"bye\n");
    assert!(
        !root.join("new").exists(),
        "emptied directories are removed"
    );
    assert_eq!(
        read(root, "ignored.log"),
        b"after\n",
        "ignored files are never touched"
    );

    // The pre-restore snapshot undoes the restore.
    checkpoints
        .restore(root, &report.pre_restore.commit)
        .unwrap();
    assert_eq!(read(root, "keep.txt"), b"edited\n");
    assert!(root.join("new/nested/created.txt").is_file());
    assert!(!root.join("delete-me.txt").exists());
}

#[test]
fn user_repository_is_left_untouched() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(root)
        .status()
        .unwrap();
    assert!(status.success());
    write(root, "a.txt", b"a\n");
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());
    write(root, "a.txt", b"b\n");
    checkpoints.restore(root, &before.commit).unwrap();
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(root)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout), "?? a.txt\n");
    let head = Command::new("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(!head.status.success(), "no commit lands in the user's repo");
    assert!(
        !root.join(".git/index").exists(),
        "user index never written"
    );
}

#[test]
fn rejects_bad_ids_and_missing_folders() {
    let (_store, workspace, checkpoints) = fixture();
    assert!(checkpoints.restore(workspace.path(), "--help").is_err());
    assert!(checkpoints
        .restore(workspace.path(), "0123456789abcdef0123")
        .is_err());
    assert_eq!(
        checkpoints
            .snapshot(&workspace.path().join("missing"), "turn")
            .unwrap(),
        SnapshotOutcome::Skipped(SkipReason::NotADirectory)
    );
}

#[test]
fn credential_files_never_enter_a_checkpoint() {
    let (store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    let secret = b"OPENAI_API_KEY=sk-live-checkpoint-secret-0123456789";
    write(root, "src/main.rs", b"fn main() {}\n");
    write(root, ".env", secret);
    write(root, "app/.env.local", secret);
    write(root, "certs/server.pem", secret);
    write(root, "deploy/id_ed25519", secret);
    write(root, ".npmrc", secret);
    write(root, "src/env.rs", b"// ordinary source\n");
    let snapshot = captured(checkpoints.snapshot(root, "turn").unwrap());
    let shadow = checkpoints.shadow_for(&resolve_workspace(root).unwrap());
    let listed = shadow
        .run(&["ls-tree", "-r", "--name-only", &snapshot.commit])
        .unwrap();
    let names: Vec<&str> = listed.lines().collect();
    assert!(names.contains(&"src/main.rs"));
    assert!(names.contains(&"src/env.rs"));
    for path in [
        ".env",
        "app/.env.local",
        "certs/server.pem",
        "deploy/id_ed25519",
        ".npmrc",
    ] {
        assert!(!names.contains(&path), "snapshotted {path}");
    }
    // The secret bytes are in no object, loose or packed.
    let objects = shadow
        .run(&["cat-file", "--batch-all-objects", "--batch"])
        .unwrap();
    assert!(!objects.contains("sk-live-checkpoint-secret"));
    // A rewind leaves credential files alone.
    write(root, ".env", b"rotated");
    checkpoints.restore(root, &snapshot.commit).unwrap();
    assert_eq!(read(root, ".env"), b"rotated");
    drop(store);
}

#[test]
fn credential_files_tracked_by_the_user_repository_are_not_copied() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    let git = |args: &[&str]| {
        let status = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgSign=false",
            ])
            .args(args)
            .current_dir(root)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "--quiet"]);
    write(root, "a.txt", b"a\n");
    write(root, "config/.env", b"TOKEN=tracked-secret");
    git(&["add", "--all"]);
    git(&["commit", "--quiet", "-m", "init"]);
    let snapshot = captured(checkpoints.snapshot(root, "turn").unwrap());
    let shadow = checkpoints.shadow_for(&resolve_workspace(root).unwrap());
    let listed = shadow
        .run(&["ls-tree", "-r", "--name-only", &snapshot.commit])
        .unwrap();
    assert!(listed.lines().any(|line| line == "a.txt"));
    assert!(
        !listed.lines().any(|line| line == "config/.env"),
        "{listed}"
    );
}

#[test]
fn stores_from_older_builds_gain_the_credential_exclusions() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "a.txt", b"a\n");
    captured(checkpoints.snapshot(root, "turn").unwrap());
    let shadow = checkpoints.shadow_for(&resolve_workspace(root).unwrap());
    let exclude = shadow.git_dir.join("info").join("exclude");
    std::fs::write(&exclude, DEFAULT_EXCLUDES).unwrap();
    write(root, ".env", b"TOKEN=late-secret");
    let snapshot = captured(checkpoints.snapshot(root, "turn").unwrap());
    let text = std::fs::read_to_string(&exclude).unwrap();
    assert_eq!(text.matches(SENSITIVE_EXCLUDES_MARKER).count(), 1);
    let listed = shadow
        .run(&["ls-tree", "-r", "--name-only", &snapshot.commit])
        .unwrap();
    assert!(!listed.lines().any(|line| line == ".env"));
}

#[test]
fn large_files_are_excluded() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "small.txt", b"x");
    let big = std::fs::File::create(root.join("big [1].bin")).unwrap();
    big.set_len(MAX_SNAPSHOT_FILE_BYTES + 1).unwrap();
    let snapshot = captured(checkpoints.snapshot(root, "turn").unwrap());
    std::fs::remove_file(root.join("big [1].bin")).unwrap();
    let changes = checkpoints.changes_since(root, &snapshot.commit).unwrap();
    assert!(
        changes.is_empty(),
        "large file was never tracked: {changes:?}"
    );
}

/// A file that was small at the checkpoint and grew past the size limit is
/// not in the pre-restore snapshot. Overwriting it would lose its only copy.
#[test]
fn a_file_that_grew_too_large_is_never_overwritten() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "data.bin", b"small");
    write(root, "other.txt", b"one");
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());

    let mut big = vec![7u8; usize::try_from(MAX_SNAPSHOT_FILE_BYTES).unwrap() + 10];
    big[0] = 42;
    std::fs::write(root.join("data.bin"), &big).unwrap();
    write(root, "other.txt", b"two");

    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert_eq!(
        skipped_paths(&report),
        vec![("data.bin", SkippedReason::NotSaved)]
    );
    assert_eq!(read(root, "data.bin"), big, "unsaved bytes kept");
    assert_eq!(read(root, "other.txt"), b"one", "the rest restored");
}

/// A file that is ignored now but existed in the checkpoint is not saved in
/// the pre-restore snapshot, so it is left alone too.
#[test]
fn a_newly_ignored_file_is_never_overwritten() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "notes.txt", b"checkpoint");
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());
    // Untrack it in the shadow index the way a fresh store would see it:
    // the file is ignored by the time of the next snapshot.
    write(root, ".gitignore", b"notes.txt\n");
    let shadow = checkpoints.shadow_for(&resolve_workspace(root).unwrap());
    shadow
        .run(&["rm", "--cached", "--quiet", "notes.txt"])
        .unwrap();
    write(root, "notes.txt", b"precious unsaved edit");

    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert_eq!(
        skipped_paths(&report),
        vec![("notes.txt", SkippedReason::NotSaved)]
    );
    assert_eq!(read(root, "notes.txt"), b"precious unsaved edit");
    assert!(
        !root.join(".gitignore").exists(),
        ".gitignore was added since"
    );
}

/// A folder that now holds an ignored file blocks restoring a file of the
/// same name. The ignored file must survive.
#[test]
fn a_folder_with_ignored_contents_blocks_a_file_restore() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, ".gitignore", b"*.log\n");
    write(root, "x", b"was a file");
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());

    std::fs::remove_file(root.join("x")).unwrap();
    write(root, "x/new.txt", b"new");
    write(root, "x/keep.log", b"ignored, never snapshotted");

    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert_eq!(report.removed, vec!["x/new.txt".to_owned()]);
    assert_eq!(
        skipped_paths(&report),
        vec![("x", SkippedReason::PathBlocked)]
    );
    assert_eq!(read(root, "x/keep.log"), b"ignored, never snapshotted");
}

#[test]
fn files_and_folders_swap_both_ways() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "a", b"file a");
    write(root, "b/inner.txt", b"inside b");
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());
    let expected = tree(root);

    std::fs::remove_file(root.join("a")).unwrap();
    write(root, "a/child.txt", b"a is a folder now");
    std::fs::remove_dir_all(root.join("b")).unwrap();
    write(root, "b", b"b is a file now");

    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(tree(root), expected);
}

#[cfg(unix)]
#[test]
fn never_writes_through_a_symlinked_folder() {
    let (_store, workspace, checkpoints) = fixture();
    let outside = tempfile::tempdir().expect("outside");
    let root = workspace.path();
    write(root, "dir/a.txt", b"checkpoint content");
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());

    std::fs::remove_dir_all(root.join("dir")).unwrap();
    write(outside.path(), "a.txt", b"outside file, not ours");
    std::os::unix::fs::symlink(outside.path(), root.join("dir")).unwrap();

    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(
        read(outside.path(), "a.txt"),
        b"outside file, not ours",
        "nothing written outside the workspace"
    );
    let meta = std::fs::symlink_metadata(root.join("dir")).unwrap();
    assert!(meta.is_dir() && !meta.file_type().is_symlink());
    assert_eq!(read(root, "dir/a.txt"), b"checkpoint content");
}

#[cfg(unix)]
#[test]
fn symlinks_exec_bits_and_odd_names_round_trip() {
    use std::os::unix::ffi::OsStrExt as _;
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "run.sh", b"#!/bin/sh\necho hi\n");
    set_executable(&root.join("run.sh"), true);
    std::os::unix::fs::symlink("run.sh", root.join("link")).unwrap();
    std::os::unix::fs::symlink("../escape", root.join("dangling")).unwrap();
    write(root, "-leading dash.txt", b"dash");
    write(root, "spaced name/ü ñ 文件.txt", b"unicode");
    let latin1 = std::ffi::OsStr::from_bytes(b"latin1-\xe9.txt");
    std::fs::write(root.join(latin1), b"not utf-8 name").unwrap();
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());
    let expected = tree(root);

    set_executable(&root.join("run.sh"), false);
    std::fs::remove_file(root.join("link")).unwrap();
    write(root, "link", b"a regular file now");
    std::fs::remove_file(root.join("dangling")).unwrap();
    std::fs::remove_file(root.join("-leading dash.txt")).unwrap();
    std::fs::remove_dir_all(root.join("spaced name")).unwrap();
    std::fs::write(root.join(latin1), b"changed").unwrap();

    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(tree(root), expected);
}

/// In-tree attributes (line-ending conversion, LFS filters) must not change
/// the bytes a snapshot stores or a restore writes.
#[test]
fn content_is_byte_exact_despite_gitattributes() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(
        root,
        ".gitattributes",
        b"* text=auto eol=crlf\n*.bin filter=lfs diff=lfs merge=lfs -text\n*.txt ident\n",
    );
    write(root, "mixed.txt", b"lf\ncrlf\r\nlone cr\r $Id$ \n");
    write(root, "blob.bin", &[0, 159, 146, 150, 0, 255, 10, 13]);
    write(root, "empty.txt", b"");
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());
    let expected = tree(root);

    write(root, "mixed.txt", b"replaced");
    write(root, "blob.bin", b"replaced");
    std::fs::remove_file(root.join("empty.txt")).unwrap();
    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(tree(root), expected);
}

#[test]
fn nested_repositories_are_never_touched() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "top.txt", b"top");
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());
    write(root, "vendor/lib/code.rs", b"cloned after the checkpoint");
    let status = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(root.join("vendor/lib"))
        .status()
        .unwrap();
    assert!(status.success());

    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.removed.is_empty(), "{:?}", report.removed);
    assert_eq!(
        read(root, "vendor/lib/code.rs"),
        b"cloned after the checkpoint"
    );
}

#[test]
fn a_stale_index_lock_from_a_crash_does_not_break_snapshots() {
    let (store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "a.txt", b"one");
    captured(checkpoints.snapshot(root, "turn 1").unwrap());
    let git_dir = std::fs::read_dir(store.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::write(git_dir.join("index.lock"), b"").unwrap();
    write(root, "a.txt", b"two");
    let second = captured(checkpoints.snapshot(root, "turn 2").unwrap());
    write(root, "a.txt", b"three");
    checkpoints.restore(root, &second.commit).unwrap();
    assert_eq!(
        read(root, "a.txt"),
        b"two",
        "snapshot was current, not stale"
    );
}

/// Restoring the same checkpoint twice, or restoring onto an unchanged
/// folder, is a no-op that still yields an undo point.
#[test]
fn repeated_restores_are_idempotent() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "a.txt", b"one");
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());
    write(root, "a.txt", b"two");
    let first = checkpoints.restore(root, &before.commit).unwrap();
    let second = checkpoints.restore(root, &before.commit).unwrap();
    assert_eq!(first.restored, vec!["a.txt".to_owned()]);
    assert!(second.restored.is_empty() && second.removed.is_empty());
    let shadow = checkpoints.shadow_for(&resolve_workspace(root).unwrap());
    let tree_of = |commit: &str| {
        shadow
            .run(&["rev-parse", &format!("{commit}^{{tree}}")])
            .unwrap()
    };
    assert_eq!(tree_of(&second.pre_restore.commit), tree_of(&before.commit));
    assert_eq!(read(root, "a.txt"), b"one");
}

/// Deterministic xorshift so a failure reproduces from its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % bound as u64).unwrap()
    }

    fn bytes(&mut self) -> Vec<u8> {
        let alphabet: &[&[u8]] = &[b"a", b"\n", b"\r\n", b"\0", b"\xff", b"z ", b"$Id$"];
        (0..self.below(12))
            .flat_map(|_| alphabet[self.below(alphabet.len())].to_vec())
            .collect()
    }
}

const FUZZ_PATHS: &[&str] = &[
    "a",
    "b.txt",
    "c.bin",
    "d/e",
    "d/f.txt",
    "d/g/h",
    "d/g/i.txt",
    "j/k",
    "j/l/m",
    "n",
];

/// Apply one random change. Parents that are files are removed first, and a
/// path that is a folder is removed before it becomes a file, mirroring what
/// a tool or shell command does.
fn mutate(root: &Path, rng: &mut Rng) {
    let relative = FUZZ_PATHS[rng.below(FUZZ_PATHS.len())];
    let path = root.join(relative);
    let clear_parents = |path: &Path| {
        let mut ancestor = root.to_path_buf();
        for component in path
            .strip_prefix(root)
            .unwrap()
            .parent()
            .unwrap()
            .components()
        {
            ancestor.push(component);
            if let Ok(meta) = std::fs::symlink_metadata(&ancestor) {
                if !meta.is_dir() {
                    std::fs::remove_file(&ancestor).unwrap();
                }
            }
        }
    };
    let clear_self = |path: &Path| match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path).unwrap(),
        Ok(_) => std::fs::remove_file(path).unwrap(),
        Err(_) => {}
    };
    match rng.below(7) {
        0 | 1 | 2 => {
            clear_parents(&path);
            clear_self(&path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, rng.bytes()).unwrap();
        }
        3 => clear_self(&path),
        4 =>
        {
            #[cfg(unix)]
            if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) {
                set_executable(&path, rng.below(2) == 0);
            }
        }
        5 => {
            #[cfg(unix)]
            {
                clear_parents(&path);
                clear_self(&path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                let target = FUZZ_PATHS[rng.below(FUZZ_PATHS.len())];
                std::os::unix::fs::symlink(target, &path).unwrap();
            }
        }
        _ => {
            // Ignored files are never snapshotted; a rewind must keep them.
            let name = format!("note-{}.log", rng.below(3));
            std::fs::write(root.join(name), rng.bytes()).unwrap();
        }
    }
}

fn without_ignored(tree: &BTreeMap<PathBuf, Node>) -> BTreeMap<PathBuf, Node> {
    tree.iter()
        .filter(|(path, _)| path.extension().and_then(|ext| ext.to_str()) != Some("log"))
        .map(|(path, node)| (path.clone(), node.clone()))
        .collect()
}

fn only_ignored(tree: &BTreeMap<PathBuf, Node>) -> BTreeMap<PathBuf, Node> {
    tree.iter()
        .filter(|(path, _)| path.extension().and_then(|ext| ext.to_str()) == Some("log"))
        .map(|(path, node)| (path.clone(), node.clone()))
        .collect()
}

/// Random folders, random edits, then: restore reproduces the checkpoint
/// exactly, ignored files are untouched, and undoing the restore reproduces
/// the pre-rewind folder exactly. Nothing is ever lost.
#[test]
fn randomized_rewinds_restore_exactly_and_lose_nothing() {
    for seed in 1..=150u64 {
        let (_store, workspace, checkpoints) = fixture();
        let root = workspace.path();
        write(root, ".gitattributes", b"* text=auto eol=crlf\n");
        write(root, ".gitignore", b"*.log\n");
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let mut checkpoints_taken = Vec::new();
        for _ in 0..3 {
            for _ in 0..rng.below(8) + 1 {
                mutate(root, &mut rng);
            }
            let snapshot = captured(checkpoints.snapshot(root, "turn").unwrap());
            checkpoints_taken.push((snapshot.commit, tree(root)));
        }
        for _ in 0..rng.below(10) + 1 {
            mutate(root, &mut rng);
        }

        let (commit, at_checkpoint) = &checkpoints_taken[rng.below(checkpoints_taken.len())];
        let before_restore = tree(root);
        let report = checkpoints.restore(root, commit).unwrap();
        assert!(
            report.skipped.is_empty(),
            "seed {seed}: unexpected skips {:?}",
            report.skipped
        );
        let after = tree(root);
        assert_eq!(
            without_ignored(&after),
            without_ignored(at_checkpoint),
            "seed {seed}: restore did not reproduce the checkpoint"
        );
        assert_eq!(
            only_ignored(&after),
            only_ignored(&before_restore),
            "seed {seed}: ignored files changed"
        );

        let undo = checkpoints
            .restore(root, &report.pre_restore.commit)
            .unwrap();
        assert!(undo.skipped.is_empty(), "seed {seed}: {:?}", undo.skipped);
        assert_eq!(
            tree(root),
            before_restore,
            "seed {seed}: undo did not reproduce the pre-rewind folder"
        );
    }
}

fn user_git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(args)
        .current_dir(root)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// A folder that is a Git repository seeds its first snapshot from that
/// repository. Its stored blobs are the output of clean filters (normalized
/// line endings, an LFS-style filter), so a naive seed would restore the
/// wrong bytes. After the background copy the user's repository can vanish.
#[test]
fn seeding_from_the_project_repository_is_byte_exact_and_self_contained() {
    let (store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    user_git(root, &["init", "--quiet"]);
    user_git(root, &["config", "filter.upper.clean", "tr a-z A-Z"]);
    user_git(root, &["config", "filter.upper.smudge", "cat"]);
    write(
        root,
        ".gitattributes",
        b"*.txt text eol=lf\n*.dat filter=upper\n",
    );
    write(root, "crlf.txt", b"one\r\ntwo\r\n");
    write(root, "filtered.dat", b"lower case bytes\n");
    write(root, "plain.rs", b"fn main() {}\n");
    write(root, "untracked.md", b"not committed\n");
    // Real projects have files older than their index, so Git trusts the
    // index stat data and does not re-hash them. Reproduce that: a file
    // modified in the same second as the index would be re-hashed anyway.
    let an_hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    for name in [".gitattributes", "crlf.txt", "filtered.dat", "plain.rs"] {
        std::fs::File::options()
            .write(true)
            .open(root.join(name))
            .unwrap()
            .set_modified(an_hour_ago)
            .unwrap();
    }
    user_git(
        root,
        &[
            "add",
            ".gitattributes",
            "crlf.txt",
            "filtered.dat",
            "plain.rs",
        ],
    );
    user_git(root, &["commit", "--quiet", "-m", "init"]);
    let expected = tree(root);
    let user_repo_before = tree(&root.join(".git"));

    let before = captured(checkpoints.snapshot(root, "turn").unwrap());
    assert_eq!(
        tree(&root.join(".git")),
        user_repo_before,
        "seeding never writes to the user's repository"
    );
    let git_dir = std::fs::read_dir(store.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(!git_dir.join(SEED_PENDING).exists(), "seed was verified");

    for name in ["crlf.txt", "filtered.dat", "plain.rs", "untracked.md"] {
        write(root, name, b"agent rewrote this");
    }
    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(tree(root), expected, "seeded restore is byte exact");

    checkpoints.localize_objects(root).unwrap();
    assert!(
        !git_dir.join("objects/info/alternates").exists(),
        "store no longer borrows objects"
    );
    std::fs::remove_dir_all(root.join(".git")).unwrap();
    let expected = tree(root);
    write(root, "plain.rs", b"changed again");
    std::fs::remove_file(root.join("crlf.txt")).unwrap();
    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(
        tree(root),
        expected,
        "restores work after the user's repository is gone"
    );
}

/// A data folder kept inside the project must not snapshot its own store.
#[test]
fn a_store_inside_the_workspace_never_snapshots_itself() {
    let workspace = tempfile::tempdir().expect("workspace");
    let root = workspace.path();
    let checkpoints = WorkspaceCheckpoints::new(root.join(".ryu/chat-checkpoints"));
    write(root, "a.txt", b"one");
    let before = captured(checkpoints.snapshot(root, "turn 1").unwrap());
    captured(checkpoints.snapshot(root, "turn 2").unwrap());
    write(root, "a.txt", b"two");
    let changes = checkpoints.changes_since(root, &before.commit).unwrap();
    assert_eq!(
        changes,
        vec![FileChange {
            path: "a.txt".into(),
            kind: FileChangeKind::Modified
        }],
        "store objects never appear as workspace changes"
    );
    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert!(root.join(".ryu/chat-checkpoints").is_dir(), "store intact");
}

#[cfg(unix)]
#[test]
fn restoring_a_file_keeps_its_private_permissions() {
    use std::os::unix::fs::PermissionsExt as _;
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "private-notes.txt", b"old");
    std::fs::set_permissions(
        root.join("private-notes.txt"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let before = captured(checkpoints.snapshot(root, "turn").unwrap());
    write(root, "private-notes.txt", b"agent");
    let report = checkpoints.restore(root, &before.commit).unwrap();
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert_eq!(read(root, "private-notes.txt"), b"old");
    let mode = std::fs::metadata(root.join("private-notes.txt"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "permissions were widened to {mode:o}");
}

fn object_exists(store: &Path, commit: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(store) else {
        return false;
    };
    entries.flatten().any(|entry| {
        Command::new("git")
            .arg("--git-dir")
            .arg(entry.path())
            .args(["cat-file", "-e", &format!("{commit}^{{commit}}")])
            .status()
            .is_ok_and(|status| status.success())
    })
}

#[test]
fn releasing_an_owner_drops_its_snapshots_and_keeps_others() {
    let (store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "a.txt", b"one-conversation-a\n");
    let a = captured(checkpoints.snapshot(root, "turn a").unwrap());
    checkpoints.pin(root, "conv-a", &a.commit).unwrap();
    write(root, "a.txt", b"two-conversation-b\n");
    let b = captured(checkpoints.snapshot(root, "turn b").unwrap());
    checkpoints.pin(root, "conv-b", &b.commit).unwrap();
    write(root, "a.txt", b"three\n");

    checkpoints.release_owner(root, "conv-a").unwrap();
    assert!(
        !object_exists(store.path(), &a.commit),
        "released snapshot is gone"
    );
    assert!(
        object_exists(store.path(), &b.commit),
        "other owner's snapshot stays"
    );
    checkpoints.restore(root, &b.commit).unwrap();
    assert_eq!(read(root, "a.txt"), b"two-conversation-b\n");

    // The last owner going away deletes the whole store.
    checkpoints.release_owner(root, "conv-b").unwrap();
    assert_eq!(std::fs::read_dir(store.path()).unwrap().count(), 0);
}

#[test]
fn releasing_several_owners_at_once_keeps_the_rest() {
    let (store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    let mut commits = Vec::new();
    for (index, owner) in ["conv-a", "conv-b", "conv-c"].iter().enumerate() {
        write(
            root,
            "a.txt",
            format!("version-{index}-{owner}\n").as_bytes(),
        );
        let snapshot = captured(checkpoints.snapshot(root, "turn").unwrap());
        checkpoints.pin(root, owner, &snapshot.commit).unwrap();
        commits.push(snapshot.commit);
    }
    write(root, "a.txt", b"current\n");

    checkpoints
        .release_owners(root, &["conv-a", "conv-c"])
        .unwrap();
    assert!(!object_exists(store.path(), &commits[0]), "conv-a released");
    assert!(object_exists(store.path(), &commits[1]), "conv-b stays");
    assert!(!object_exists(store.path(), &commits[2]), "conv-c released");

    checkpoints.release_owners(root, &[]).unwrap();
    assert!(
        object_exists(store.path(), &commits[1]),
        "an empty release is a no-op"
    );
    checkpoints.release_owners(root, &["conv-b"]).unwrap();
    assert_eq!(std::fs::read_dir(store.path()).unwrap().count(), 0);
}

#[test]
fn age_cap_drops_old_snapshots_and_empty_stores() {
    let (store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "a.txt", b"old\n");
    let old = captured(checkpoints.snapshot(root, "turn").unwrap());
    checkpoints.pin(root, "conv", &old.commit).unwrap();
    // Nothing is old enough yet.
    let report = checkpoints
        .prune_older_than(std::time::Duration::from_secs(3600))
        .unwrap();
    assert_eq!(report, PruneReport::default());
    assert!(object_exists(store.path(), &old.commit));
    // A zero cap drops everything.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let report = checkpoints
        .prune_older_than(std::time::Duration::from_secs(0))
        .unwrap();
    assert_eq!(report.dropped_snapshots, 1);
    assert_eq!(report.removed_stores, 1);
    assert_eq!(std::fs::read_dir(store.path()).unwrap().count(), 0);
}

#[test]
fn a_store_from_an_older_build_keeps_its_chain_until_it_ages_out() {
    let (store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "a.txt", b"legacy\n");
    let legacy = captured(checkpoints.snapshot(root, "turn").unwrap());
    // Simulate an older build's store: no marker, snapshot only on `main`.
    let git_dir = std::fs::read_dir(store.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::remove_file(git_dir.join(PARENTLESS_MARKER)).unwrap();
    write(root, "a.txt", b"new\n");
    let new = captured(checkpoints.snapshot(root, "turn").unwrap());
    checkpoints.pin(root, "conv-new", &new.commit).unwrap();
    checkpoints.release_owner(root, "conv-new").unwrap();
    // The legacy chain is still referenced, so the store stays.
    assert!(object_exists(store.path(), &legacy.commit));
    std::thread::sleep(std::time::Duration::from_millis(1100));
    checkpoints
        .prune_older_than(std::time::Duration::from_secs(0))
        .unwrap();
    assert_eq!(std::fs::read_dir(store.path()).unwrap().count(), 0);
}

#[test]
fn credential_files_stay_out_of_snapshots() {
    let (_store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, ".env", b"TOKEN=secret-env-marker\n");
    write(root, "notes.txt", b"kept\n");
    let snapshot = captured(checkpoints.snapshot(root, "turn").unwrap());
    write(root, "notes.txt", b"changed\n");
    let changes = checkpoints.changes_since(root, &snapshot.commit).unwrap();
    assert!(changes.iter().all(|change| change.path != ".env"));
}

fn store_git_dir(store: &Path) -> PathBuf {
    std::fs::read_dir(store)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
}

fn store_git(git_dir: &Path, args: &[&str], envs: &[(&str, &str)]) -> String {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(git_dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@t"])
        .args(args)
        .envs(envs.iter().copied())
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[test]
fn reusing_a_stale_head_still_survives_the_age_cap() {
    let (store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "a.txt", b"unchanged for weeks\n");
    let first = captured(checkpoints.snapshot(root, "turn").unwrap());
    // Make HEAD look like it was committed 40 days ago (Core not run since).
    let git_dir = store_git_dir(store.path());
    let tree = store_git(
        &git_dir,
        &["rev-parse", &format!("{}^{{tree}}", first.commit)],
        &[],
    );
    let old_date = format!(
        "{} +0000",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 40 * 24 * 60 * 60
    );
    let stale = store_git(
        &git_dir,
        &["commit-tree", &tree, "-m", "old"],
        &[
            ("GIT_COMMITTER_DATE", old_date.as_str()),
            ("GIT_AUTHOR_DATE", old_date.as_str()),
        ],
    );
    store_git(&git_dir, &["update-ref", "HEAD", &stale], &[]);

    let turn = captured(
        checkpoints
            .snapshot_pinned(root, "new turn", "conv-new")
            .unwrap(),
    );
    assert_ne!(
        turn.commit, stale,
        "a stale HEAD is not reused for a new pin"
    );
    checkpoints
        .prune_older_than(std::time::Duration::from_secs(30 * 24 * 60 * 60))
        .unwrap();
    assert!(
        object_exists(store.path(), &turn.commit),
        "the new pin survives"
    );
    write(root, "a.txt", b"edited by the agent\n");
    checkpoints.restore(root, &turn.commit).unwrap();
    assert_eq!(read(root, "a.txt"), b"unchanged for weeks\n");

    // A recent unchanged HEAD is still reused.
    let again = captured(checkpoints.snapshot(root, "turn").unwrap());
    let once_more = captured(checkpoints.snapshot(root, "turn").unwrap());
    assert_eq!(again.commit, once_more.commit);
}

#[test]
fn releasing_the_latest_capture_prunes_its_blobs_from_the_index_too() {
    let (store, workspace, checkpoints) = fixture();
    let root = workspace.path();
    write(root, "a.txt", b"kept by conversation b\n");
    let kept = captured(
        checkpoints
            .snapshot_pinned(root, "turn b", "conv-b")
            .unwrap(),
    );
    write(root, "secret.txt", b"only-conversation-a-marker\n");
    let released = captured(
        checkpoints
            .snapshot_pinned(root, "turn a", "conv-a")
            .unwrap(),
    );
    std::fs::remove_file(root.join("secret.txt")).unwrap();
    let git_dir = store_git_dir(store.path());
    let blob = store_git(
        &git_dir,
        &["rev-parse", &format!("{}:secret.txt", released.commit)],
        &[],
    );

    checkpoints.release_owner(root, "conv-a").unwrap();
    let blob_exists = Command::new("git")
        .arg("--git-dir")
        .arg(&git_dir)
        .args(["cat-file", "-e", &blob])
        .status()
        .unwrap()
        .success();
    assert!(!blob_exists, "the released capture's blob is pruned");
    assert!(!object_exists(store.path(), &released.commit));
    assert!(object_exists(store.path(), &kept.commit));
    // The store still snapshots and restores after its index was dropped.
    write(root, "a.txt", b"changed\n");
    checkpoints.restore(root, &kept.commit).unwrap();
    assert_eq!(read(root, "a.txt"), b"kept by conversation b\n");
}
