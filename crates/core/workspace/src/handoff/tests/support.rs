//! Fixtures for the handoff tests: a bare remote, clones, and tree snapshots.

use super::*;

pub(super) fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

pub(super) fn configure(dir: &Path) {
    git(dir, &["config", "user.email", "test@ryu"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    // Byte-identity assertions compare checkouts against files written
    // with `\n`; a host `core.autocrlf=true` (Git for Windows' system
    // default) would check them out as `\r\n`.
    git(dir, &["config", "core.autocrlf", "false"]);
}

/// A bare "remote", a source clone A with one pushed commit, and the
/// remote's default branch tip.
pub(super) struct Fixture {
    pub(super) _temp: TempDir,
    pub(super) remote: PathBuf,
    pub(super) source: PathBuf,
    pub(super) root: PathBuf,
}

pub(super) fn fixture() -> Fixture {
    let temp = TempDir::new().unwrap();
    let root = plain_path(std::fs::canonicalize(temp.path()).unwrap());
    let remote = root.join("remote.git");
    let source = root.join("a");
    git(
        &root,
        &["init", "--bare", "--quiet", "-b", "main", "remote.git"],
    );
    git(&root, &["init", "--quiet", "-b", "main", "a"]);
    configure(&source);
    std::fs::write(source.join("README.md"), "hello\n").unwrap();
    std::fs::write(source.join(".gitignore"), "ignored.log\n").unwrap();
    std::fs::write(source.join("tracked.bin"), [0u8, 1, 2, 3, 255]).unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "--quiet", "-m", "init"]);
    git(
        &source,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&source, &["push", "--quiet", "-u", "origin", "main"]);
    Fixture {
        _temp: temp,
        remote,
        source,
        root,
    }
}

/// `canonicalize` resolves symlinked temp dirs (macOS `/var`), but on
/// Windows it also adds the `\\?\` verbatim prefix, which Git reads as a
/// UNC host when the path is a remote. Drop it for drive-letter paths.
pub(super) fn plain_path(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|text| text.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

/// Forward-slash form of `path`, which both Git and `sh` accept on Windows
/// (`sh` would treat backslashes as escapes).
pub(super) fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// A `file://` URL for `path`; a Windows drive path needs `file:///C:/...`.
pub(super) fn file_url(path: &Path) -> String {
    let slashed = slash_path(path);
    if slashed.starts_with('/') {
        format!("file://{slashed}")
    } else {
        format!("file:///{slashed}")
    }
}

pub(super) fn clone_to(fixture: &Fixture, name: &str, shallow: bool) -> PathBuf {
    let url = file_url(&fixture.remote);
    let mut args = vec!["clone", "--quiet"];
    if shallow {
        args.extend(["--depth", "1"]);
    }
    args.extend([url.as_str(), name]);
    git(&fixture.root, &args);
    let path = fixture.root.join(name);
    configure(&path);
    path
}

pub(super) fn commit_file(dir: &Path, name: &str, contents: &str) {
    std::fs::write(dir.join(name), contents).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "--quiet", "-m", name]);
}

pub(super) fn manifest_paths(exported: &ExportedWorkspace) -> BTreeSet<String> {
    exported
        .diff
        .as_ref()
        .map(|diff| diff.files.iter().map(|file| file.path.clone()).collect())
        .unwrap_or_default()
}

pub(super) fn materialize(
    exported: &ExportedWorkspace,
    destination: &Path,
    name: &str,
) -> HandoffResult<Materialized> {
    materialize_handoff(&MaterializeRequest {
        repo_root: destination.to_path_buf(),
        bundle: exported
            .commits
            .as_ref()
            .map(|commits| commits.path.clone()),
        head: exported.inspection.head.clone(),
        branch: "handoff/thread-1".to_owned(),
        worktree_dir: destination.join(".ryu-worktrees").join(name),
        diff: exported.diff.as_ref().map(|diff| diff.path.clone()),
        expected_paths: manifest_paths(exported),
        marker: r#"{"workspaceId":"w1"}"#.to_owned(),
    })
}

/// Every file under `dir` except `.git`, with contents.
pub(super) fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == ".ryu-worktrees" || name == "ignored.log" {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(base, &path, out);
            } else {
                let relative = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.push((relative, std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}
