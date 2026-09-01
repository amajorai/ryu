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
fn git_without_hooks(args: &[&str]) -> Command {
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
fn reject_local_executable_filters(cwd: &str) -> Result<(), String> {
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

const MAX_FILE_DIFF_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextReplacement {
    pub after: String,
    pub before: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReverseEditsConflictReason {
    ChangedSinceTurn,
    StagedChanges,
    UnsupportedFile,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReverseEditsOutcome {
    Applied {
        paths: Vec<String>,
    },
    Conflict {
        paths: Vec<String>,
        reason: ReverseEditsConflictReason,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct GitFileDiff {
    pub patch: String,
    pub paths: Vec<String>,
}

struct RepositoryPaths {
    cwd: PathBuf,
    root: PathBuf,
}

fn repository_paths(cwd: &str) -> Result<RepositoryPaths, String> {
    let cwd = std::fs::canonicalize(cwd).map_err(|_| "cwd could not be resolved".to_string())?;
    if !cwd.is_dir() {
        return Err("cwd is not a directory".to_string());
    }
    let root = run_git(
        cwd.to_string_lossy().as_ref(),
        &["rev-parse", "--show-toplevel"],
    )
    .ok_or_else(|| "not a git repository".to_string())?;
    let root = std::fs::canonicalize(root)
        .map_err(|_| "repository root could not be resolved".to_string())?;
    if !cwd.starts_with(&root) {
        return Err("cwd must stay inside the repository".to_string());
    }
    Ok(RepositoryPaths { cwd, root })
}

fn validate_repository_path(
    repository: &RepositoryPaths,
    raw: &str,
    allow_missing: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let raw_path = Path::new(raw);
    if raw.trim().is_empty()
        || raw_path
            .components()
            .any(|component| component == Component::ParentDir)
    {
        return Err("file paths must stay inside the repository".to_string());
    }
    let candidate = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        repository.cwd.join(raw_path)
    };
    let relative = candidate
        .strip_prefix(&repository.root)
        .map_err(|_| "file paths must stay inside the repository".to_string())?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("file paths must name files inside the repository".to_string());
    }

    let mut current = repository.root.clone();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("symbolic links cannot be reviewed or reversed".to_string())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("file path does not exist".to_string())
            }
            Err(_) => return Err("file path could not be inspected".to_string()),
        }
    }
    if candidate.is_dir() {
        return Err("only files can be reviewed or reversed".to_string());
    }
    Ok((relative.to_path_buf(), candidate))
}

fn git_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn path_has_staged_changes(root: &Path, relative: &Path) -> Result<bool, String> {
    let status = Command::new("git")
        .args(["diff", "--cached", "--quiet", "--"])
        .arg(relative)
        .current_dir(root)
        .no_window()
        .status()
        .map_err(|_| "could not inspect staged changes".to_string())?;
    match status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err("could not inspect staged changes".to_string()),
    }
}

static ACTIVE_EDIT_REVERSALS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

struct EditReversalGuard {
    repository: PathBuf,
}

impl Drop for EditReversalGuard {
    fn drop(&mut self) {
        if let Some(active) = ACTIVE_EDIT_REVERSALS.get() {
            if let Ok(mut repositories) = active.lock() {
                repositories.remove(&self.repository);
            }
        }
    }
}

fn begin_edit_reversal(repository: &Path) -> Result<EditReversalGuard, String> {
    let active = ACTIVE_EDIT_REVERSALS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut repositories = active
        .lock()
        .map_err(|_| "edit reversal lock is unavailable".to_string())?;
    if !repositories.insert(repository.to_path_buf()) {
        return Err("another edit reversal is already in progress".to_string());
    }
    Ok(EditReversalGuard {
        repository: repository.to_path_buf(),
    })
}

struct PreparedFile {
    absolute: PathBuf,
    current: String,
    next: String,
    permissions: std::fs::Permissions,
    relative: PathBuf,
}

fn changed_since_turn(paths: Vec<String>) -> ReverseEditsOutcome {
    ReverseEditsOutcome::Conflict {
        paths,
        reason: ReverseEditsConflictReason::ChangedSinceTurn,
    }
}

pub fn reverse_text_edits(
    cwd: &str,
    edits: &[TextReplacement],
) -> Result<ReverseEditsOutcome, String> {
    if edits.is_empty() {
        return Err("at least one text replacement is required".to_string());
    }
    let repository = repository_paths(cwd)?;
    let _guard = begin_edit_reversal(&repository.root)?;
    let mut file_indexes = HashMap::<PathBuf, usize>::new();
    let mut files = Vec::<PreparedFile>::new();

    for edit in edits {
        if edit.after.is_empty() || edit.after == edit.before {
            return Err("text replacements must contain a non-empty changed value".to_string());
        }
        let (relative, absolute) = validate_repository_path(&repository, &edit.path, false)?;
        if file_indexes.contains_key(&relative) {
            continue;
        }
        if path_has_staged_changes(&repository.root, &relative)? {
            return Ok(ReverseEditsOutcome::Conflict {
                paths: vec![git_path(&relative)],
                reason: ReverseEditsConflictReason::StagedChanges,
            });
        }
        let bytes = std::fs::read(&absolute).map_err(|_| "file could not be read".to_string())?;
        let Ok(current) = String::from_utf8(bytes) else {
            return Ok(ReverseEditsOutcome::Conflict {
                paths: vec![git_path(&relative)],
                reason: ReverseEditsConflictReason::UnsupportedFile,
            });
        };
        let permissions = std::fs::metadata(&absolute)
            .map_err(|_| "file metadata could not be read".to_string())?
            .permissions();
        let index = files.len();
        file_indexes.insert(relative.clone(), index);
        files.push(PreparedFile {
            absolute,
            current: current.clone(),
            next: current,
            permissions,
            relative,
        });
    }

    for edit in edits.iter().rev() {
        let (relative, _) = validate_repository_path(&repository, &edit.path, false)?;
        let Some(index) = file_indexes.get(&relative).copied() else {
            return Err("validated edit path disappeared".to_string());
        };
        let file = &mut files[index];
        let mut matches = file.next.match_indices(&edit.after);
        let Some((start, _)) = matches.next() else {
            return Ok(changed_since_turn(vec![git_path(&relative)]));
        };
        if matches.next().is_some() {
            return Ok(changed_since_turn(vec![git_path(&relative)]));
        }
        file.next
            .replace_range(start..start + edit.after.len(), &edit.before);
    }

    let mut written = Vec::new();
    for (index, file) in files.iter().enumerate() {
        if file.current == file.next {
            continue;
        }
        if let Err(error) = std::fs::write(&file.absolute, file.next.as_bytes())
            .and_then(|()| std::fs::set_permissions(&file.absolute, file.permissions.clone()))
        {
            for written_index in written.into_iter().rev() {
                let previous: &PreparedFile = &files[written_index];
                let _ = std::fs::write(&previous.absolute, previous.current.as_bytes());
                let _ = std::fs::set_permissions(&previous.absolute, previous.permissions.clone());
            }
            return Err(format!("writing reversed edits failed: {error}"));
        }
        written.push(index);
    }

    Ok(ReverseEditsOutcome::Applied {
        paths: files.iter().map(|file| git_path(&file.relative)).collect(),
    })
}

fn untracked_file_patch(relative: &Path, absolute: &Path) -> Result<String, String> {
    let bytes =
        std::fs::read(absolute).map_err(|_| "untracked file could not be read".to_string())?;
    let path = git_path(relative);
    if bytes.len() > MAX_FILE_DIFF_BYTES || bytes.contains(&0) {
        return Ok(format!(
            "diff --git a/{path} b/{path}\nnew file mode 100644\nBinary files /dev/null and b/{path} differ\n"
        ));
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "untracked file is not valid UTF-8".to_string())?;
    let line_count = content.lines().count();
    let mut patch = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{line_count} @@\n"
    );
    for line in content.lines() {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if !content.is_empty() && !content.ends_with('\n') {
        patch.push_str("\\ No newline at end of file\n");
    }
    Ok(patch)
}

pub fn query_file_diff(cwd: &str, paths: &[String]) -> Result<GitFileDiff, String> {
    if paths.is_empty() {
        return Err("at least one file path is required".to_string());
    }
    let repository = repository_paths(cwd)?;
    let mut seen = HashSet::new();
    let mut resolved = Vec::new();
    for raw in paths {
        let (relative, absolute) = validate_repository_path(&repository, raw, true)?;
        if seen.insert(relative.clone()) {
            resolved.push((relative, absolute));
        }
    }

    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for (relative, absolute) in &resolved {
        let status = Command::new("git")
            .args(["ls-files", "--error-unmatch", "--"])
            .arg(relative)
            .current_dir(&repository.root)
            .no_window()
            .status()
            .map_err(|_| "could not inspect tracked files".to_string())?;
        if status.success() {
            tracked.push(relative.clone());
        } else if absolute.is_file() {
            untracked.push((relative.clone(), absolute.clone()));
        } else {
            return Err(format!("{} does not exist", git_path(relative)));
        }
    }

    let mut patch = String::new();
    if !tracked.is_empty() {
        let output = Command::new("git")
            .args(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"])
            .args(&tracked)
            .current_dir(&repository.root)
            .no_window()
            .output()
            .map_err(|_| "could not read file diff".to_string())?;
        if !output.status.success() {
            return Err(command_failure("diff", &output));
        }
        patch.push_str(&String::from_utf8_lossy(&output.stdout));
    }
    for (relative, absolute) in &untracked {
        patch.push_str(&untracked_file_patch(relative, absolute)?);
    }
    if patch.len() > MAX_FILE_DIFF_BYTES {
        return Err("file diff exceeds the response limit".to_string());
    }

    Ok(GitFileDiff {
        patch,
        paths: resolved
            .iter()
            .map(|(relative, _)| git_path(relative))
            .collect(),
    })
}

fn current_branch(cwd: &str) -> Option<String> {
    // `rev-parse --abbrev-ref HEAD` returns the literal `HEAD` for a freshly
    // initialized repository with no commits. The symbolic ref is authoritative
    // in that state and keeps the Environment row on the branch Git initialized.
    run_git(cwd, &["symbolic-ref", "--short", "HEAD"])
        .or_else(|| run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]))
}

fn command_failure(operation: &str, output: &Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(400)
        .collect::<String>();
    if details.is_empty() {
        format!("git {operation} failed")
    } else {
        format!("git {operation} failed: {details}")
    }
}

/// Compute the working-tree state for `cwd` (branch, ahead/behind, dirty, diff
/// totals). Returns `is_repo:false` when `cwd` is not a git repository.
pub fn query_git_state(cwd: &str) -> GitState {
    // Confirm this is actually a git repo.
    let branch = current_branch(cwd);
    let is_repo = branch.is_some();

    if !is_repo {
        return GitState {
            is_repo: false,
            branch: None,
            ahead: 0,
            behind: 0,
            dirty: false,
            changed_files_count: 0,
            insertions: 0,
            deletions: 0,
        };
    }

    // Dirty state from porcelain output — one line per changed file.
    // `--untracked-files=all` lists new files individually rather than collapsing
    // a new directory into a single row, so `changed_files_count` counts the same
    // files the insertion total below is summed over.
    let porcelain =
        run_git(cwd, &["status", "--porcelain", "--untracked-files=all"]).unwrap_or_default();
    let changed: Vec<&str> = porcelain.lines().filter(|l| !l.is_empty()).collect();
    let dirty = !changed.is_empty();

    // Ahead / behind relative to the upstream branch. Fails gracefully when no
    // tracking branch is configured — defaults to 0/0.
    let ahead_behind = run_git(cwd, &["rev-list", "--count", "--left-right", "@{u}...HEAD"]);
    let (behind, ahead) = parse_ahead_behind(ahead_behind.as_deref());

    let (tracked_insertions, deletions) = query_diff_totals(cwd);
    let insertions =
        tracked_insertions.saturating_add(untracked_insertions(cwd, &untracked_paths(&porcelain)));

    GitState {
        is_repo: true,
        branch,
        ahead,
        behind,
        dirty,
        changed_files_count: changed.len(),
        insertions,
        deletions,
    }
}

/// Read the bounded Git history for the Markdown memory subtree.
///
/// The caller supplies a repository that the user explicitly configured as the
/// Memory source. Keeping this primitive read-only and path-scoped lets agents
/// inspect what changed without granting them an arbitrary repository walker.
pub fn query_memory_trace(
    cwd: &str,
    path: &str,
    limit: usize,
) -> Result<Vec<GitMemoryTraceCommit>, String> {
    if !Path::new(cwd).is_dir() {
        return Err("memory Git source is not a directory".to_string());
    }
    if current_branch(cwd).is_none() {
        return Err("memory Git source is not a repository".to_string());
    }
    let path = path.trim();
    if path.is_empty() {
        return Err("memory Git trace path is required".to_string());
    }
    let relative = Path::new(path);
    if relative.is_absolute()
        || path.chars().any(|character| character.is_control())
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
        || (path != "memory" && !path.starts_with("memory/"))
    {
        return Err("memory Git trace path must stay below memory/".to_string());
    }

    let max_count = limit.clamp(1, 50).to_string();
    let output = Command::new("git")
        .args([
            "log",
            "--no-renames",
            &format!("--max-count={max_count}"),
            "--date=iso-strict",
            "--format=%H%x1f%an%x1f%aI%x1f%s",
            "--name-only",
            "--",
            path,
        ])
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|error| format!("could not read memory Git history: {error}"))?;
    if !output.status.success() {
        return Err(command_failure("log", &output));
    }

    let mut commits = Vec::new();
    let mut current: Option<GitMemoryTraceCommit> = None;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        if fields.len() == 4 && fields[0].len() >= 7 {
            if let Some(commit) = current.take() {
                commits.push(commit);
            }
            current = Some(GitMemoryTraceCommit {
                author: fields[1].to_owned(),
                files: Vec::new(),
                hash: fields[0].to_owned(),
                subject: fields[3].to_owned(),
                timestamp: fields[2].to_owned(),
            });
            continue;
        }
        if line.starts_with("memory/") {
            if let Some(commit) = current.as_mut() {
                if !commit.files.iter().any(|file| file == line) {
                    commit.files.push(line.to_owned());
                }
            }
        }
    }
    if let Some(commit) = current {
        commits.push(commit);
    }
    Ok(commits)
}

/// Parse `git rev-list --count --left-right @{u}...HEAD` output: "<behind>\t<ahead>".
fn parse_ahead_behind(raw: Option<&str>) -> (u32, u32) {
    let Some(s) = raw else {
        return (0, 0);
    };
    let mut parts = s.split_whitespace();
    let behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    (behind, ahead)
}

/// Shaped `GET /api/git/branches` result: local branches plus the current one.
#[derive(serde::Serialize)]
pub struct GitBranches {
    pub is_repo: bool,
    pub current: Option<String>,
    pub branches: Vec<String>,
}

/// Shaped `POST /api/git/init` result: whether Core created the repository and
/// which branch Git initialized it on.
#[derive(serde::Serialize)]
pub struct GitInitOutcome {
    pub success: bool,
    pub initialized: bool,
    pub branch: Option<String>,
}

/// Initialize a local repository with `main` as its default branch.
///
/// This intentionally does not stage files or create a commit. The caller can
/// review the local Git state first, then use the normal commit flow before
/// publishing the repository to a provider.
pub fn initialize_repository(cwd: &str) -> Result<GitInitOutcome, String> {
    if !std::path::Path::new(cwd).is_dir() {
        return Err("cwd is not a directory".to_string());
    }
    if let Some(branch) = current_branch(cwd) {
        return Ok(GitInitOutcome {
            success: true,
            initialized: false,
            branch: Some(branch),
        });
    }

    let output = git_without_hooks(&["init", "-b", "main"])
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|_| "could not start git init".to_string())?;
    if !output.status.success() {
        return Err(command_failure("init", &output));
    }

    Ok(GitInitOutcome {
        success: true,
        initialized: true,
        branch: current_branch(cwd),
    })
}

/// List local branches plus the currently checked-out one for `cwd`. Returns
/// `is_repo:false` when `cwd` is not a git repository.
pub fn list_branches(cwd: &str) -> GitBranches {
    let current = current_branch(cwd);
    if current.is_none() {
        return GitBranches {
            is_repo: false,
            current: None,
            branches: Vec::new(),
        };
    }

    // Most-recently-committed first, not git's default alphabetical order. The
    // list is NOT paged — `checkout_branch` re-lists to validate its argument, so
    // a server-side limit would make any branch past the cut unreachable — but a
    // client that shows only the head of a long list should be showing the
    // branches actually in play, not the ones that happen to start with "a".
    let raw = run_git(
        cwd,
        &[
            "branch",
            "--sort=-committerdate",
            "--format=%(refname:short)",
        ],
    )
    .unwrap_or_default();
    let branches: Vec<String> = raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    GitBranches {
        is_repo: true,
        current,
        branches,
    }
}

/// Switch `cwd` to an existing local branch via `git switch`.
///
/// The branch is validated against the actual branch list to reject typos and
/// argument injection (a name beginning with `-`). Returns the raw git stderr on
/// failure so the caller can surface it (e.g. uncommitted-changes conflicts).
pub fn checkout_branch(cwd: &str, branch: &str) -> Result<String, String> {
    // Only switch to a branch git itself reports — guards against typos and any
    // argument-injection (e.g. a name beginning with '-').
    let known = list_branches(cwd);
    if !known.is_repo {
        return Err("not a git repository".to_string());
    }
    if !known.branches.iter().any(|b| b == branch) {
        return Err(format!("branch '{branch}' not found"));
    }
    reject_local_executable_filters(cwd)?;

    let out = git_without_hooks(&["switch", branch])
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if out.status.success() {
        Ok(branch.to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Create a new branch off the current HEAD and switch to it (`git switch -c`).
///
/// Guards against argument injection (a name beginning with `-`) and obvious bad
/// input; git validates the full ref-name grammar itself and errors cleanly.
/// Returns the raw git stderr on failure (e.g. the branch already exists).
pub fn create_branch(cwd: &str, branch: &str) -> Result<String, String> {
    if !list_branches(cwd).is_repo {
        return Err("not a git repository".to_string());
    }
    // Guard against argument injection (a name beginning with '-') and obvious bad
    // input; git validates the full ref-name grammar itself and errors cleanly.
    let name = branch.trim();
    if name.is_empty()
        || name.starts_with('-')
        || name.contains("..")
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!("'{branch}' is not a valid branch name"));
    }
    reject_local_executable_filters(cwd)?;

    let out = git_without_hooks(&["switch", "-c", name])
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if out.status.success() {
        Ok(name.to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Shaped `POST /api/git/commit-push` result: what the action actually did.
#[derive(serde::Serialize)]
pub struct CommitPushOutcome {
    pub success: bool,
    pub committed: bool,
    pub pushed: bool,
    pub commit: Option<String>,
}

/// Commit, push, or do both for `cwd`. `action` is one of `commit`,
/// `commit-push`, or `push` (validated by the caller). When `include_unstaged`
/// is set, stages everything before committing. Mutating commands reject
/// repo-local executable filters, disable hooks, and return bounded operation
/// errors rather than forwarding untrusted hook output to the caller.
pub fn run_git_action(
    cwd: &str,
    message: &str,
    action: &str,
    include_unstaged: bool,
) -> Result<CommitPushOutcome, String> {
    // Confirm this is a git repo before touching the working tree.
    if current_branch(cwd).is_none() {
        return Err("not a git repository".to_string());
    }
    if action != "push" && include_unstaged {
        reject_local_executable_filters(cwd)?;
    }

    if action != "push" && include_unstaged {
        // Stage everything. A failure here is fatal (e.g. corrupt index).
        let add = git_without_hooks(&["add", "-A"])
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git add".to_string())?;
        if !add.status.success() {
            return Err(git_mutation_failed("add"));
        }
    }

    let mut committed = false;
    if action != "push" {
        let has_head = run_git(cwd, &["rev-parse", "--verify", "HEAD"]).is_some();
        let staged_args = ["diff", "--cached", "--name-only"];
        let has_staged = run_git(cwd, &staged_args)
            .map(|s| s.lines().any(|l| !l.trim().is_empty()))
            .unwrap_or(false);

        if !has_staged && include_unstaged {
            let has_changes = run_git(cwd, &["status", "--porcelain"])
                .map(|s| s.lines().any(|l| !l.trim().is_empty()))
                .unwrap_or(false);
            if has_changes {
                return Err("no staged changes to commit".to_string());
            }
        }

        let mut commit_args = vec!["commit", "--no-verify", "-m", message];
        // A newly initialized, empty folder has no staged paths yet, but it
        // still needs an initial commit before `gh repo create --push` can
        // publish it. Preserve the normal no-op behavior for an established
        // repository while allowing the unborn branch to get a real root.
        if !has_head && !has_staged {
            commit_args.insert(1, "--allow-empty");
        }
        let commit = git_without_hooks(&commit_args)
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git commit".to_string())?;
        if (!has_head || has_staged) && commit.status.success() {
            committed = true;
        } else if has_staged || !has_head {
            return Err(git_mutation_failed("commit"));
        }
    }

    let mut pushed = false;
    if action != "commit" {
        // Push to the configured upstream. When there is no tracking branch git
        // exits non-zero with a helpful message — surface it verbatim.
        let push = git_without_hooks(&["push", "--no-verify"])
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git push".to_string())?;
        if !push.status.success() {
            return Err(git_mutation_failed("push"));
        }
        pushed = true;
    }

    let commit = run_git(cwd, &["rev-parse", "--short", "HEAD"]);

    Ok(CommitPushOutcome {
        success: true,
        committed,
        pushed,
        commit,
    })
}

/// Shaped `POST /api/git/pull` and `POST /api/git/sync` result.
#[derive(Debug, serde::Serialize)]
pub struct GitRemoteOutcome {
    pub success: bool,
    pub pulled: bool,
    pub pushed: bool,
    pub commit: Option<String>,
}

fn remote_git_failed(operation: &str, output: &std::process::Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(400)
        .collect::<String>();
    if details.is_empty() {
        format!("git {operation} failed")
    } else {
        format!("git {operation} failed: {details}")
    }
}

const REMOTE_GIT_TIMEOUT: Duration = Duration::from_secs(120);

/// Run a remote Git mutation without giving Git an interactive credential or
/// terminal path. A blocking `Command::output` cannot be cancelled when the
/// HTTP client disconnects, so remote actions use a supervised child with a
/// bounded lifetime and kill it on timeout.
fn run_remote_git_command(cwd: &str, args: &[&str]) -> Result<Output, String> {
    let ssh_command = std::env::var("GIT_SSH_COMMAND")
        .map(|value| format!("{value} -o BatchMode=yes"))
        .unwrap_or_else(|_| "ssh -o BatchMode=yes".to_string());
    let mut child = git_without_hooks(args)
        .current_dir(cwd)
        .no_window()
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", ssh_command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start git: {error}"))?;
    let deadline = Instant::now() + REMOTE_GIT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("could not collect git output: {error}"));
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out after 120 seconds".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("could not inspect git process: {error}"));
            }
        }
    }
}

/// Clone one repository into a new directory without exposing an incomplete
/// checkout as a project. The caller validates the source URL and destination
/// boundary; this function owns the bounded, non-interactive Git invocation.
///
/// The temporary directory is created by this process and renamed into place
/// only after `git clone` succeeds. A failed clone therefore cannot leave a
/// half-populated project folder that the desktop might register on its next
/// refresh.
pub fn clone_repository(url: &str, destination: &Path) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("clone URL is required".to_string());
    }
    if !destination.is_absolute() {
        return Err("clone destination must be an absolute path".to_string());
    }
    match std::fs::symlink_metadata(destination) {
        Ok(_) => return Err("clone destination already exists".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("clone destination could not be inspected".to_string()),
    }

    let parent = destination
        .parent()
        .filter(|path| path.is_dir())
        .ok_or_else(|| "clone destination parent is not a directory".to_string())?;
    let parent_string = parent.to_string_lossy().into_owned();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut temporary_name = None;
    for attempt in 0..8 {
        let candidate = format!(".ryu-clone-{}-{nonce}-{attempt}", std::process::id());
        match std::fs::create_dir(parent.join(&candidate)) {
            Ok(()) => {
                temporary_name = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("could not create a temporary clone directory".to_string()),
        }
    }
    let temporary_name = temporary_name
        .ok_or_else(|| "could not reserve a temporary clone directory".to_string())?;
    let temporary_path = parent.join(&temporary_name);
    let cleanup = || {
        if std::fs::symlink_metadata(&temporary_path)
            .map(|metadata| metadata.file_type().is_dir())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_dir_all(&temporary_path);
        }
    };

    let output = match run_remote_git_command(
        &parent_string,
        &[
            "clone",
            "--depth",
            "1",
            "--no-recurse-submodules",
            "--",
            url,
            &temporary_name,
        ],
    ) {
        Ok(output) => output,
        Err(error) => {
            cleanup();
            return Err(format!("git clone {error}"));
        }
    };
    if !output.status.success() {
        let error = remote_git_failed("clone", &output);
        cleanup();
        return Err(error);
    }
    if !temporary_path.is_dir() {
        cleanup();
        return Err("git clone completed without creating a repository".to_string());
    }
    if std::fs::symlink_metadata(destination).is_ok() {
        cleanup();
        return Err("clone destination appeared while cloning".to_string());
    }
    if let Err(error) = std::fs::rename(&temporary_path, destination) {
        cleanup();
        return Err(format!("could not finalize cloned repository: {error}"));
    }
    Ok(())
}

/// Pull the current branch from its upstream, or pull and then push for sync.
///
/// Pull is deliberately fast-forward-only: the Environment summary must not
/// create an implicit merge commit or leave a conflict in the user's folder.
/// Sync uses the same pull first, then pushes the current branch to its
/// configured upstream. Neither action stages or commits working-tree files.
pub fn run_git_remote_action(cwd: &str, action: &str) -> Result<GitRemoteOutcome, String> {
    if !matches!(action, "pull" | "sync") {
        return Err("invalid git remote action".to_string());
    }
    // Confirm this is a git repo before running a mutating remote command.
    if current_branch(cwd).is_none() {
        return Err("not a git repository".to_string());
    }
    reject_local_executable_filters(cwd)?;

    let pull = run_remote_git_command(cwd, &["pull", "--ff-only", "--no-recurse-submodules"])
        .map_err(|error| format!("git pull {error}"))?;
    if !pull.status.success() {
        return Err(remote_git_failed("pull", &pull));
    }

    let pushed = action == "sync";
    if pushed {
        let push = run_remote_git_command(cwd, &["push", "--no-verify"])
            .map_err(|error| format!("git push {error}"))?;
        if !push.status.success() {
            return Err(remote_git_failed("push", &push));
        }
    }

    Ok(GitRemoteOutcome {
        success: true,
        pulled: true,
        pushed,
        commit: run_git(cwd, &["rev-parse", "--short", "HEAD"]),
    })
}

const PULL_REQUEST_FIELDS: &str =
    "baseRefName,commentsCount,headRefName,headRefOid,isDraft,number,repository,state,title,url";

#[derive(serde::Deserialize)]
struct GhRepository {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: Option<String>,
}

#[derive(serde::Deserialize)]
struct GhPullRequest {
    #[serde(rename = "baseRefName")]
    base_ref_name: Option<String>,
    #[serde(rename = "commentsCount")]
    comments_count: Option<u64>,
    #[serde(rename = "headRefName")]
    head_ref_name: Option<String>,
    #[serde(rename = "headRefOid")]
    head_ref_oid: Option<String>,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    number: u64,
    repository: Option<GhRepository>,
    state: Option<String>,
    title: String,
    url: String,
}

static ACTIVE_PR_CREATIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct PullRequestCreationGuard {
    key: String,
}

impl Drop for PullRequestCreationGuard {
    fn drop(&mut self) {
        if let Some(active) = ACTIVE_PR_CREATIONS.get() {
            if let Ok(mut keys) = active.lock() {
                keys.remove(&self.key);
            }
        }
    }
}

fn begin_pull_request_creation(
    cwd: &str,
    branch: &str,
) -> Result<PullRequestCreationGuard, String> {
    let key = format!("{cwd}\0{branch}");
    let active = ACTIVE_PR_CREATIONS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut keys = active
        .lock()
        .map_err(|_| "pull request operation lock is unavailable".to_string())?;
    if !keys.insert(key.clone()) {
        return Err("a pull request operation is already in progress for this branch".to_string());
    }
    Ok(PullRequestCreationGuard { key })
}

fn list_open_pull_requests(cwd: &str, branch: &str) -> Result<Vec<GhPullRequest>, String> {
    let args = [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--limit",
        "2",
        "--json",
        PULL_REQUEST_FIELDS,
    ];
    let gh = Command::new("gh")
        .args(args)
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run gh: {e}"))?;
    if !gh.status.success() {
        return Err(String::from_utf8_lossy(&gh.stderr).trim().to_string());
    }
    serde_json::from_slice(&gh.stdout).map_err(|e| format!("invalid gh pull request response: {e}"))
}

fn existing_open_pull_request(cwd: &str, branch: &str) -> Result<Option<GhPullRequest>, String> {
    let mut pulls = list_open_pull_requests(cwd, branch)?;
    if pulls.len() > 1 {
        return Err(format!(
            "more than one open pull request exists for branch {branch}"
        ));
    }
    Ok(pulls.pop())
}

fn pull_request_outcome(
    pull: &GhPullRequest,
    branch: &str,
    fallback_base: Option<&str>,
    already_exists: bool,
) -> PullRequestOutcome {
    PullRequestOutcome {
        already_exists,
        base: pull
            .base_ref_name
            .clone()
            .or_else(|| fallback_base.map(str::to_owned)),
        branch: pull
            .head_ref_name
            .clone()
            .unwrap_or_else(|| branch.to_string()),
        comments_count: pull.comments_count,
        head_sha: pull.head_ref_oid.clone(),
        is_draft: pull.is_draft,
        number: Some(pull.number),
        pr_url: pull.url.clone(),
        repository: pull
            .repository
            .as_ref()
            .and_then(|repo| repo.name_with_owner.clone()),
        state: pull.state.clone(),
        success: true,
        title: Some(pull.title.clone()),
    }
}

/// Shaped `POST /api/git/pull-request` result. The URL is returned by `gh` so
/// the desktop can offer both a completion link and an explicit browser action.
#[derive(serde::Serialize)]
pub struct PullRequestOutcome {
    pub already_exists: bool,
    pub base: Option<String>,
    pub branch: String,
    pub comments_count: Option<u64>,
    pub head_sha: Option<String>,
    pub is_draft: bool,
    pub number: Option<u64>,
    pub pr_url: String,
    pub repository: Option<String>,
    pub state: Option<String>,
    pub success: bool,
    pub title: Option<String>,
}

/// Optionally commit local changes, push the current branch, and create a pull
/// request through the authenticated GitHub CLI. Arguments are passed directly
/// to `git`/`gh` — no shell interpolation is used.
pub fn create_pull_request(
    cwd: &str,
    title: Option<&str>,
    body: Option<&str>,
    base: Option<&str>,
    draft: bool,
    include_unstaged: bool,
) -> Result<PullRequestOutcome, String> {
    let branch = current_branch(cwd).ok_or_else(|| "not a git repository".to_string())?;
    if branch == "HEAD" {
        return Err("cannot create a pull request from a detached HEAD".to_string());
    }

    // The UI check is only an affordance. The node owns the final decision so
    // two concurrent clicks (or two desktop windows) cannot create two PRs for
    // the same local branch.
    let _creation_guard = begin_pull_request_creation(cwd, &branch)?;
    if include_unstaged {
        reject_local_executable_filters(cwd)?;
    }
    if let Some(existing) = existing_open_pull_request(cwd, &branch)? {
        return Ok(pull_request_outcome(
            &existing,
            &branch,
            base.map(str::trim).filter(|value| !value.is_empty()),
            true,
        ));
    }

    let requested_title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Update {branch}"));

    if include_unstaged {
        let add = git_without_hooks(&["add", "-A"])
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git add".to_string())?;
        if !add.status.success() {
            return Err(git_mutation_failed("add"));
        }
    }

    let staged = run_git(cwd, &["diff", "--cached", "--name-only"])
        .map(|value| value.lines().any(|line| !line.trim().is_empty()))
        .unwrap_or(false);
    if staged {
        let message = title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Update via Ryu");
        let commit = git_without_hooks(&["commit", "--no-verify", "-m", message])
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git commit".to_string())?;
        if !commit.status.success() {
            return Err(git_mutation_failed("commit"));
        }
    }

    let has_upstream = run_git(
        cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .is_some();
    let push_args: &[&str] = if has_upstream {
        &["push", "--no-verify"]
    } else {
        &["push", "--no-verify", "-u", "origin", "HEAD"]
    };
    let push = git_without_hooks(push_args)
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|_| "could not start git push".to_string())?;
    if !push.status.success() {
        return Err(git_mutation_failed("push"));
    }

    let body = body.unwrap_or("");
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--head".to_string(),
        branch.clone(),
        "--title".to_string(),
        requested_title.clone(),
        "--body".to_string(),
        body.to_string(),
    ];
    if let Some(base) = base.map(str::trim).filter(|value| !value.is_empty()) {
        args.extend(["--base".to_string(), base.to_string()]);
    }
    if draft {
        args.push("--draft".to_string());
    }

    let gh = Command::new("gh")
        .args(&args)
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run gh: {e}"))?;
    if !gh.status.success() {
        return Err(String::from_utf8_lossy(&gh.stderr).trim().to_string());
    }
    let pr_url = String::from_utf8_lossy(&gh.stdout).trim().to_string();
    if pr_url.is_empty() {
        return Err("gh did not return a pull request URL".to_string());
    }

    // A second lookup closes the check-then-create race across Core processes
    // and enriches the result with the title/number/repository the app uses for
    // its compact CI surface. The URL is still a valid success result if GitHub
    // accepts creation but the follow-up read is temporarily unavailable.
    if let Ok(Some(created)) = existing_open_pull_request(cwd, &branch) {
        return Ok(pull_request_outcome(
            &created,
            &branch,
            base.map(str::trim).filter(|value| !value.is_empty()),
            false,
        ));
    }

    Ok(PullRequestOutcome {
        already_exists: false,
        base: base
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        branch,
        comments_count: None,
        head_sha: None,
        is_draft: draft,
        number: None,
        pr_url,
        repository: None,
        state: Some("OPEN".to_string()),
        success: true,
        title: Some(requested_title),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn initialize_reverse_repo(path: &std::path::Path) {
        test_git(path, &["init"]);
        test_git(path, &["config", "user.name", "Ryu Test"]);
        test_git(path, &["config", "user.email", "ryu-test@example.com"]);
        std::fs::write(path.join("first.txt"), "alpha\none\nomega\n").unwrap();
        std::fs::write(path.join("second.txt"), "left\nright\n").unwrap();
        test_git(path, &["add", "first.txt", "second.txt"]);
        test_git(path, &["commit", "-m", "initial"]);
    }

    #[test]
    fn reverse_text_edits_preserves_unrelated_changes_and_reverses_in_order() {
        let dir = tempfile::tempdir().unwrap();
        initialize_reverse_repo(dir.path());
        std::fs::write(
            dir.path().join("first.txt"),
            "user note\nalpha\nthree\nomega\n",
        )
        .unwrap();

        let result = reverse_text_edits(
            dir.path().to_str().unwrap(),
            &[
                TextReplacement {
                    after: "two".to_string(),
                    before: "one".to_string(),
                    path: "first.txt".to_string(),
                },
                TextReplacement {
                    after: "three".to_string(),
                    before: "two".to_string(),
                    path: "first.txt".to_string(),
                },
            ],
        )
        .unwrap();

        assert_eq!(
            result,
            ReverseEditsOutcome::Applied {
                paths: vec!["first.txt".to_string()]
            }
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("first.txt")).unwrap(),
            "user note\nalpha\none\nomega\n"
        );
    }

    #[test]
    fn reverse_text_edits_conflicts_without_writing_any_file() {
        let dir = tempfile::tempdir().unwrap();
        initialize_reverse_repo(dir.path());
        std::fs::write(
            dir.path().join("first.txt"),
            "alpha\nchanged later\nomega\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("second.txt"), "LEFT\nright\n").unwrap();

        let result = reverse_text_edits(
            dir.path().to_str().unwrap(),
            &[
                TextReplacement {
                    after: "changed by agent".to_string(),
                    before: "one".to_string(),
                    path: "first.txt".to_string(),
                },
                TextReplacement {
                    after: "LEFT".to_string(),
                    before: "left".to_string(),
                    path: "second.txt".to_string(),
                },
            ],
        )
        .unwrap();

        assert_eq!(
            result,
            ReverseEditsOutcome::Conflict {
                paths: vec!["first.txt".to_string()],
                reason: ReverseEditsConflictReason::ChangedSinceTurn,
            }
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("second.txt")).unwrap(),
            "LEFT\nright\n"
        );
    }

    #[test]
    fn reverse_text_edits_rejects_staged_targets() {
        let dir = tempfile::tempdir().unwrap();
        initialize_reverse_repo(dir.path());
        std::fs::write(dir.path().join("first.txt"), "alpha\ntwo\nomega\n").unwrap();
        test_git(dir.path(), &["add", "first.txt"]);

        let result = reverse_text_edits(
            dir.path().to_str().unwrap(),
            &[TextReplacement {
                after: "two".to_string(),
                before: "one".to_string(),
                path: "first.txt".to_string(),
            }],
        )
        .unwrap();

        assert_eq!(
            result,
            ReverseEditsOutcome::Conflict {
                paths: vec!["first.txt".to_string()],
                reason: ReverseEditsConflictReason::StagedChanges,
            }
        );
    }

    #[test]
    fn reverse_text_edits_rejects_ambiguous_binary_and_escaping_paths() {
        let dir = tempfile::tempdir().unwrap();
        initialize_reverse_repo(dir.path());
        std::fs::write(dir.path().join("first.txt"), "two and two\n").unwrap();
        let ambiguous = reverse_text_edits(
            dir.path().to_str().unwrap(),
            &[TextReplacement {
                after: "two".to_string(),
                before: "one".to_string(),
                path: "first.txt".to_string(),
            }],
        )
        .unwrap();
        assert_eq!(
            ambiguous,
            ReverseEditsOutcome::Conflict {
                paths: vec!["first.txt".to_string()],
                reason: ReverseEditsConflictReason::ChangedSinceTurn,
            }
        );

        std::fs::write(dir.path().join("first.txt"), [0xff, 0x00]).unwrap();
        let binary = reverse_text_edits(
            dir.path().to_str().unwrap(),
            &[TextReplacement {
                after: "two".to_string(),
                before: "one".to_string(),
                path: "first.txt".to_string(),
            }],
        )
        .unwrap();
        assert_eq!(
            binary,
            ReverseEditsOutcome::Conflict {
                paths: vec!["first.txt".to_string()],
                reason: ReverseEditsConflictReason::UnsupportedFile,
            }
        );

        let escaped = reverse_text_edits(
            dir.path().to_str().unwrap(),
            &[TextReplacement {
                after: "new".to_string(),
                before: "old".to_string(),
                path: "../outside.txt".to_string(),
            }],
        )
        .unwrap_err();
        assert!(escaped.contains("inside the repository"));
    }

    #[test]
    fn query_file_diff_is_scoped_and_includes_untracked_text() {
        let dir = tempfile::tempdir().unwrap();
        initialize_reverse_repo(dir.path());
        std::fs::write(dir.path().join("first.txt"), "alpha\nTWO\nomega\n").unwrap();
        std::fs::write(dir.path().join("untracked.txt"), "new\nlines\n").unwrap();
        std::fs::write(dir.path().join("second.txt"), "changed but excluded\n").unwrap();

        let diff = query_file_diff(
            dir.path().to_str().unwrap(),
            &["first.txt".to_string(), "untracked.txt".to_string()],
        )
        .unwrap();

        assert_eq!(diff.paths, vec!["first.txt", "untracked.txt"]);
        assert!(diff.patch.contains("first.txt"));
        assert!(diff.patch.contains("+TWO"));
        assert!(diff.patch.contains("new file mode"));
        assert!(diff.patch.contains("+lines"));
        assert!(!diff.patch.contains("second.txt"));
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

        assert_eq!(
            std::fs::read_to_string(destination.join("README.md")).unwrap(),
            "hello\n"
        );
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
}
