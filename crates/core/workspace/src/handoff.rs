//! Working-tree handoff: package a thread's git working tree on one node and
//! rebuild it as a persistent worktree on another (RNP v0 workspace payload).
//!
//! Three steps, each a plain function the Core handlers call inside
//! `spawn_blocking`:
//!
//! - [`inspect_workspace`] reads what would move (HEAD, branch, remote, the
//!   tracked changes and the untracked candidates) without writing anything.
//! - [`export_workspace`] writes a `git bundle` of unpushed commits and one
//!   binary patch of tracked plus *selected* untracked changes. The patch is
//!   built against a copied index, so the user's own index never changes.
//! - [`materialize_handoff`] verifies and fetches the bundle, adds a new
//!   worktree on a `handoff/<thread>` branch, cross-checks the patch's paths
//!   against the reviewed manifest, and applies it. Any failure removes the
//!   worktree and branch again.
//!
//! Git never runs repository-controlled code here: hooks are pointed at
//! `/dev/null`, external diff drivers and textconv are disabled, and
//! repository-local clean/smudge/process filters fail the call closed.
//! Ignored files are never listed, and paths are repo-relative with `/` only.

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use crate::git::{git_without_hooks, reject_local_executable_filters, run_remote_git_command};
use crate::win_process::NoWindow;

mod export;
mod git_io;
mod materialize;

pub use export::*;
use git_io::*;
pub use materialize::*;

/// Largest `git bundle` of unpushed commits.
pub const MAX_BUNDLE_BYTES: u64 = 32 * 1024 * 1024;
/// Largest binary patch of tracked plus selected untracked changes.
pub const MAX_DIFF_BYTES: u64 = 8 * 1024 * 1024;
/// Most untracked files one handoff can carry.
pub const MAX_UNTRACKED_COUNT: usize = 256;
/// Largest single untracked file.
pub const MAX_UNTRACKED_FILE_BYTES: u64 = 1024 * 1024;
/// Largest total of selected untracked files.
pub const MAX_UNTRACKED_TOTAL_BYTES: u64 = 4 * 1024 * 1024;
/// Most paths the manifest may list (changed, untracked and omitted together).
pub const MAX_MANIFEST_PATHS: usize = 2000;
/// Longest repo-relative path, in bytes.
pub const MAX_PATH_BYTES: usize = 4096;
/// Core-owned worktree folders never travel (same exclusion as chat checkpoints).
pub const EXCLUDED_PREFIXES: &[&str] = &[".ryu-worktrees/"];
/// Marker written into a handoff worktree's gitdir. Its presence tells the run
/// loop not to fork another isolated worktree from it, and tells workspace
/// trust that the folder came from another machine.
pub const HANDOFF_MARKER: &str = "ryu-handoff";

const MAX_GIT_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

/// Every handoff failure, mapped by Core to an HTTP status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffError {
    /// The folder is not inside a git work tree (or has no commits).
    NotAGitRepository,
    /// HEAD moved after the review; the caller must inspect again.
    HeadMoved { expected: String, actual: String },
    /// A cap was exceeded.
    TooLarge(String),
    /// The request or repository failed a safety rule.
    Refused(String),
    /// A commit the bundle or worktree needs is not available.
    MissingCommit(String),
    /// Git itself failed.
    Git(String),
}

impl std::fmt::Display for HandoffError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAGitRepository => formatter.write_str("not a git repository"),
            Self::HeadMoved { expected, actual } => write!(
                formatter,
                "HEAD moved from {expected} to {actual} after the review; review it again"
            ),
            Self::TooLarge(message)
            | Self::Refused(message)
            | Self::MissingCommit(message)
            | Self::Git(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for HandoffError {}

pub type HandoffResult<T> = Result<T, HandoffError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// Why a path was left out of the handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OmissionReason {
    Ignored,
    TooLarge,
    NotSelected,
    Symlink,
    Submodule,
    UnsafePath,
    NotAGitRepository,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: FileStatus,
    pub bytes: Option<u64>,
    pub binary: bool,
    pub sensitive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UntrackedCandidate {
    pub path: String,
    pub bytes: u64,
    pub sensitive: bool,
    /// False when the file cannot ride in the patch; `reason` says why.
    pub selectable: bool,
    pub reason: Option<OmissionReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Omission {
    pub path: String,
    pub reason: OmissionReason,
}

/// What the source would hand off, read without writing anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceInspection {
    pub repo_root: PathBuf,
    /// Repository name from the remote URL, or the root folder's name.
    pub name: String,
    /// `remote.origin.url` with credentials removed; `None` when it is not a
    /// network URL or could not be cleaned.
    pub remote_url: Option<String>,
    pub head: String,
    pub branch: Option<String>,
    pub upstream_ref: Option<String>,
    /// Commits on HEAD that no remote-tracking ref has (all of HEAD's history
    /// when there is no usable remote).
    pub unpushed_commits: u32,
    pub changed: Vec<ChangedFile>,
    pub untracked: Vec<UntrackedCandidate>,
    pub insertions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportedCommits {
    pub path: PathBuf,
    pub bytes: u64,
    pub tip: String,
    /// Commits the destination must already have (from the remote) before the
    /// bundle can be fetched. Empty for a full-history bundle.
    pub prerequisites: Vec<String>,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportedDiff {
    pub path: PathBuf,
    pub bytes: u64,
    /// Every path the patch touches, including selected untracked files.
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportedWorkspace {
    pub inspection: WorkspaceInspection,
    pub commits: Option<ExportedCommits>,
    pub diff: Option<ExportedDiff>,
    /// The selected untracked files, as they appear in `diff.files`.
    pub untracked: Vec<ChangedFile>,
    pub omitted: Vec<Omission>,
}

/// Everything the destination needs to rebuild the worktree.
#[derive(Debug, Clone)]
pub struct MaterializeRequest {
    pub repo_root: PathBuf,
    /// Bundle of unpushed commits, when the source had any.
    pub bundle: Option<PathBuf>,
    /// The source HEAD. The worktree starts here and the patch applies to it.
    pub head: String,
    /// Desired branch, normally `handoff/<thread>`; made unique on collision.
    pub branch: String,
    /// Absolute folder for the new worktree; must not exist.
    pub worktree_dir: PathBuf,
    /// Binary patch of the working-tree changes, when the source had any.
    pub diff: Option<PathBuf>,
    /// Exactly the paths the reviewed manifest says the patch touches.
    pub expected_paths: BTreeSet<String>,
    /// JSON written to `<gitdir>/ryu-handoff`.
    pub marker: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Materialized {
    pub worktree_path: PathBuf,
    pub branch: String,
}

// ── Path rules ────────────────────────────────────────────────────────────────

/// Mirror of `isSafeRepoRelativePath` in `@ryuhq/protocol/continuity`.
///
/// A path from another machine is accepted only as a plain, `/`-separated,
/// repo-relative path that cannot reach outside the worktree or into `.git`
/// on any platform (drive letters, UNC, NTFS short names, trailing dots).
pub fn is_safe_repo_relative_path(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return false;
    }
    if path.starts_with('/') || path.contains('\\') || path.chars().any(char::is_control) {
        return false;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    path.split('/').all(|segment| {
        let lower = segment.to_ascii_lowercase();
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && lower != ".git"
            && lower != "git~1"
            && !segment.ends_with('.')
            && !segment.ends_with(' ')
    })
}

/// The first path that collides with an earlier one once case and Unicode
/// normalization are ignored, as they are on default macOS and Windows file
/// systems. Exact duplicates collide too.
pub fn first_path_collision<'a>(paths: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    use unicode_normalization::UnicodeNormalization;
    let mut seen = std::collections::HashSet::new();
    paths.into_iter().find(|path| {
        let key: String = path.nfc().collect::<String>().to_lowercase();
        !seen.insert(key)
    })
}

/// Secret-like file names stay unticked until the reviewer opts in.
pub fn is_sensitive_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    name.starts_with(".env")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.starts_with("id_")
        || name == ".npmrc"
        || name == ".netrc"
        || name.starts_with("credentials")
}

fn is_excluded(path: &str) -> bool {
    EXCLUDED_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix) || path == prefix.trim_end_matches('/'))
}

/// Remove credentials from a remote URL. HTTPS userinfo is dropped; SSH URLs
/// survive only with the conventional `git` user and no password. Anything
/// else (local paths, `file://`, unknown schemes) returns `None`: it cannot be
/// reached from another machine and must not leak a local path.
pub fn clean_remote_url(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return None;
    }
    if let Some(rest) = value.strip_prefix("https://") {
        let (authority, path) = rest.split_once('/')?;
        let host = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        if host.is_empty() || path.is_empty() || value.contains(['?', '#']) {
            return None;
        }
        return Some(format!("https://{host}/{path}"));
    }
    if let Some(rest) = value.strip_prefix("ssh://") {
        let (authority, _) = rest.split_once('/')?;
        let (user, _) = authority.split_once('@')?;
        return (user == "git").then(|| value.to_owned());
    }
    if let Some(rest) = value.strip_prefix("git@") {
        return (rest.contains(':') && !rest.contains("://")).then(|| value.to_owned());
    }
    None
}

fn repository_name(remote_url: Option<&str>, root: &Path) -> String {
    remote_url
        .and_then(|url| url.trim_end_matches('/').rsplit(['/', ':']).next())
        .map(|name| name.strip_suffix(".git").unwrap_or(name).to_owned())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            root.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "repository".to_owned())
}

#[cfg(test)]
mod tests;
