//! Reversing an agent's text edits and scoped per-file diffs.

use super::*;

pub(super) const MAX_FILE_DIFF_BYTES: usize = 4 * 1024 * 1024;

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

pub(super) struct RepositoryPaths {
    pub(super) cwd: PathBuf,
    pub(super) root: PathBuf,
}

pub(super) fn repository_paths(cwd: &str) -> Result<RepositoryPaths, String> {
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

pub(super) fn validate_repository_path(
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

pub(super) fn git_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub(super) fn path_has_staged_changes(root: &Path, relative: &Path) -> Result<bool, String> {
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

pub(super) static ACTIVE_EDIT_REVERSALS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

pub(super) struct EditReversalGuard {
    pub(super) repository: PathBuf,
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

pub(super) fn begin_edit_reversal(repository: &Path) -> Result<EditReversalGuard, String> {
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

pub(super) struct PreparedFile {
    pub(super) absolute: PathBuf,
    pub(super) current: String,
    pub(super) next: String,
    pub(super) permissions: std::fs::Permissions,
    pub(super) relative: PathBuf,
}

pub(super) fn changed_since_turn(paths: Vec<String>) -> ReverseEditsOutcome {
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

pub(super) fn untracked_file_patch(relative: &Path, absolute: &Path) -> Result<String, String> {
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
