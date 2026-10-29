//! The git engine: status/branches plus init/checkout/create-branch,
//! pull/sync, and commit-push, all shelling `git` against a caller-supplied cwd.
//! This is the "reads/runs what-is, no policy" half of the workspace primitive;
//! the axum HTTP handlers that call these functions stay in Core (server
//! wiring), as do the pure-filesystem `/api/workspace/{new-folder,list}`
//! handlers (they shell no git — node-fs, kernel-owned).

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::win_process::NoWindow;

/// Git object storage for portable, commit-linked conversation checkpoints.
pub mod history;

mod edits;
mod local_actions;
mod pull_request;
mod remote;

pub use edits::*;
pub use local_actions::*;
pub use pull_request::*;
pub use remote::*;

/// Shaped `GET /api/git/status` result: the working-tree state of a repo cwd.
#[derive(serde::Serialize)]
pub struct GitState {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub changed_files_count: usize,
    pub insertions: u32,
    pub deletions: u32,
}

/// One read-only commit in an explicitly configured memory source repository.
#[derive(serde::Serialize)]
pub struct GitMemoryTraceCommit {
    pub author: String,
    pub files: Vec<String>,
    pub hash: String,
    pub subject: String,
    pub timestamp: String,
}

/// Files larger than this are counted as 0 added lines, the same way git treats
/// a file it decides is binary. Keeps a stray multi-gigabyte artifact in an
/// untracked folder from stalling a status poll.
const MAX_UNTRACKED_SCAN_BYTES: u64 = 2 * 1024 * 1024;

/// Added lines contributed by files git does not track yet.
///
/// `git diff HEAD --numstat` only sees tracked files, but `git status
/// --porcelain` counts untracked ones — so without this the two halves of
/// `GitState` describe different file sets, and a folder of brand-new files
/// reads as "12 files changed, +0 −0". Every line of a new file is an insertion,
/// which is what `git add -N` + `diff` would report. Binary and oversized files
/// contribute 0, matching numstat's "-" rows.
fn untracked_insertions(cwd: &str, untracked: &[String]) -> u32 {
    let root = std::path::Path::new(cwd);
    let mut insertions = 0u32;
    for rel in untracked {
        let path = root.join(rel);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_UNTRACKED_SCAN_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.is_empty() || bytes.contains(&0) {
            continue;
        }
        let newlines = bytes.iter().filter(|b| **b == b'\n').count();
        // A trailing byte that is not a newline is still a line to git.
        let lines = if bytes.last() == Some(&b'\n') {
            newlines
        } else {
            newlines + 1
        };
        insertions = insertions.saturating_add(lines as u32);
    }
    insertions
}

/// Pull the untracked paths out of `git status --porcelain --untracked-files=all`
/// output (the `?? <path>` rows), un-quoting the C-style quoting git applies to
/// paths with unusual bytes.
fn untracked_paths(porcelain: &str) -> Vec<String> {
    porcelain
        .lines()
        .filter_map(|l| l.strip_prefix("?? "))
        .map(unquote_git_path)
        .collect()
}

/// Undo Git's C-style path quoting (`"a\tb"`), including octal byte escapes.
/// Non-quoted paths pass through. Git uses octal escapes for bytes that are not
/// safe in the configured quote format, so decoding into bytes first preserves
/// UTF-8 filenames instead of treating each escaped byte as a Unicode character.
fn unquote_git_path(raw: &str) -> String {
    let Some(inner) = raw.strip_prefix('"').and_then(|s| s.strip_suffix('"')) else {
        return raw.to_string();
    };
    let bytes = inner.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        index += 1;
        let Some(&escaped) = bytes.get(index) else {
            out.push(b'\\');
            break;
        };
        match escaped {
            b'a' => out.push(0x07),
            b'b' => out.push(0x08),
            b'f' => out.push(0x0c),
            b'n' => out.push(b'\n'),
            b'r' => out.push(b'\r'),
            b't' => out.push(b'\t'),
            b'v' => out.push(0x0b),
            b'\\' | b'"' => out.push(escaped),
            b'0'..=b'7' => {
                let mut value = 0u8;
                let mut digits = 0;
                while digits < 3 {
                    let Some(&digit) = bytes.get(index) else {
                        break;
                    };
                    if !(b'0'..=b'7').contains(&digit) {
                        break;
                    }
                    value = value * 8 + (digit - b'0');
                    index += 1;
                    digits += 1;
                }
                out.push(value);
                continue;
            }
            other => {
                out.push(b'\\');
                out.push(other);
            }
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Total added/removed lines for the working tree vs HEAD (staged + unstaged),
/// summed from `git diff HEAD --numstat`. Binary files (numstat "-") are skipped.
fn query_diff_totals(cwd: &str) -> (u32, u32) {
    let numstat = run_git(cwd, &["diff", "HEAD", "--numstat"]).unwrap_or_default();
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    for line in numstat.lines() {
        let mut cols = line.split('\t');
        let adds = cols.next().and_then(|c| c.parse::<u32>().ok());
        let dels = cols.next().and_then(|c| c.parse::<u32>().ok());
        if let (Some(a), Some(d)) = (adds, dels) {
            insertions += a;
            deletions += d;
        }
    }
    (insertions, deletions)
}

fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .no_window()
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// Return a `git` command whose hook directory cannot contain a repository
/// hook. `--no-verify` covers commit/push hooks; this explicit `core.hooksPath`
/// override also protects any future mutating command added here. `/dev/null`
/// (or `NUL`) is intentionally used instead of a writable temp directory: a
/// temp directory could itself be populated by another local process between
/// creation and invocation.
pub(crate) fn git_without_hooks(args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg(format!(
            "core.hooksPath={}",
            if cfg!(windows) { "NUL" } else { "/dev/null" }
        ))
        .args(args);
    command
}

/// Repo-local clean/smudge/process filters are executable code invoked by Git
/// during staging and checkout.
/// The mutation endpoints do not have a safe way to review or authorize those
/// commands, so fail closed before staging anything. Global filters are outside
/// this repository's control and are not part of this guard.
pub(crate) fn reject_local_executable_filters(cwd: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args([
            "config",
            "--local",
            "--get-regexp",
            r"^filter\..*\.(clean|process|smudge)$",
        ])
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|_| "could not inspect repository filter configuration".to_string())?;
    if output.status.success() && !output.stdout.is_empty() {
        return Err(
            "git mutation blocked: repository-local clean/smudge/process filters are not allowed"
                .to_string(),
        );
    }
    if output.status.success() || output.status.code() == Some(1) {
        return Ok(());
    }
    Err("git mutation blocked: repository filter configuration could not be inspected".to_string())
}

fn git_mutation_failed(operation: &str) -> String {
    format!("git {operation} failed; no command output was returned")
}

#[cfg(test)]
mod tests;
