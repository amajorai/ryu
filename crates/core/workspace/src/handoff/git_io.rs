//! Git plumbing for the handoff: hook-free `git` invocations, output limits,
//! and repository lookups.

use super::*;

// ── Git plumbing ──────────────────────────────────────────────────────────────

/// A read-only or local mutation `git` invocation with hooks, external diff
/// drivers, textconv and pagers disabled. `GIT_OPTIONAL_LOCKS=0` stops
/// `status` from refreshing (and so rewriting) the user's index.
pub(super) fn git_command(cwd: &Path, args: &[&str]) -> Command {
    let mut command = git_without_hooks(&[
        "-c",
        "diff.external=",
        "-c",
        "core.pager=cat",
        "-c",
        "color.ui=false",
    ]);
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(Stdio::null())
        .no_window();
    command
}

/// Copies the index and keeps its modification time. Git trusts a cached
/// stat entry unless the entry is not older than the index file itself (the
/// "racily clean" check). A fresh mtime on the copy would hide a same-size
/// edit made within the filesystem's timestamp granularity. The source mtime
/// is read before copying, so a concurrent rewrite only makes the copy more
/// conservative. The copy is written through a handle created here rather
/// than `fs::copy`, which would carry over a read-only index's permissions
/// and leave no writable handle to stamp the mtime through.
pub(super) fn copy_index_keeping_mtime(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut reader = std::fs::File::open(source)?;
    let modified = reader.metadata()?.modified()?;
    let mut writer = std::fs::File::create(destination)?;
    std::io::copy(&mut reader, &mut writer)?;
    writer.set_modified(modified)
}

pub(super) fn run_command(mut command: Command, operation: &str) -> HandoffResult<Output> {
    let output = command
        .output()
        .map_err(|error| HandoffError::Git(format!("could not start git {operation}: {error}")))?;
    if output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(HandoffError::TooLarge(format!(
            "git {operation} produced too much output"
        )));
    }
    Ok(output)
}

pub(super) fn git_failure(operation: &str, output: &Output) -> HandoffError {
    let details = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(400)
        .collect::<String>();
    HandoffError::Git(if details.is_empty() {
        format!("git {operation} failed")
    } else {
        format!("git {operation} failed: {details}")
    })
}

pub(super) fn git_ok(cwd: &Path, args: &[&str]) -> HandoffResult<Vec<u8>> {
    let output = run_command(git_command(cwd, args), args[0])?;
    if !output.status.success() {
        return Err(git_failure(args[0], &output));
    }
    Ok(output.stdout)
}

pub(super) fn git_text(cwd: &Path, args: &[&str]) -> HandoffResult<String> {
    Ok(String::from_utf8_lossy(&git_ok(cwd, args)?)
        .trim()
        .to_owned())
}

pub(super) fn git_optional(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = run_command(git_command(cwd, args), args[0]).ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(super) fn commit_exists(cwd: &Path, commit: &str) -> bool {
    git_optional(cwd, &["cat-file", "-t", &format!("{commit}^{{commit}}")]).is_some()
}

pub(super) fn is_hex_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn repository_root(cwd: &Path) -> HandoffResult<PathBuf> {
    if !cwd.is_dir() {
        return Err(HandoffError::NotAGitRepository);
    }
    let root = git_optional(cwd, &["rev-parse", "--show-toplevel"])
        .ok_or(HandoffError::NotAGitRepository)?;
    std::fs::canonicalize(root).map_err(|_| HandoffError::NotAGitRepository)
}

pub(super) fn reject_filters(root: &Path) -> HandoffResult<()> {
    reject_local_executable_filters(root.to_string_lossy().as_ref()).map_err(HandoffError::Refused)
}

pub(super) fn split_nul(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect()
}
