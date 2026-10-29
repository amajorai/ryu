//! The legacy Git history repository, plus the Git and validation helpers the
//! store shares with it.

use super::*;

// ── Legacy Git repository (read for the import; serves until it completes) ──

pub(super) struct LegacyCommit {
    pub(super) id: String,
    pub(super) created_at: i64,
    pub(super) subject: String,
    pub(super) paths: Vec<String>,
}

pub(super) struct GitHistory<'a> {
    pub(super) root: &'a Path,
}

impl<'a> GitHistory<'a> {
    pub(super) fn new(root: &'a Path) -> Self {
        Self { root }
    }

    pub(super) fn checkpoint(
        &self,
        relative_path: &str,
        content: &str,
        label: Option<&str>,
    ) -> std::io::Result<SourceHistoryVersion> {
        self.ensure_repository()?;
        let destination = self.root.join(relative_path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&destination, content.as_bytes())?;
        restrict_to_owner(&destination)?;

        self.run_git(&["add", "--", relative_path])?;
        let changed = self.run_git_status(&["diff", "--cached", "--quiet", "--", relative_path])?;
        if changed > 1 {
            return Err(io_error("could not inspect the staged source checkpoint"));
        }
        let has_label = label.is_some_and(|value| !value.trim().is_empty());
        if changed == 0 && !has_label {
            return self
                .latest_for_path(relative_path)?
                .ok_or_else(|| io_error("Git source history has no checkpoint"));
        }

        let subject = commit_subject(label);
        let trailer = format!("{SOURCE_PATH_TRAILER} {relative_path}");
        let mut commit = git_command(self.root);
        commit
            .args([
                "-c",
                "user.name=Ryu",
                "-c",
                "user.email=local@ryu.dev",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "--no-verify",
            ])
            .args((changed == 0).then_some("--allow-empty"))
            .args([
                "--only",
                "-m",
                subject.as_str(),
                "-m",
                trailer.as_str(),
                "--",
            ])
            .arg(relative_path)
            .current_dir(self.root);
        let output = commit.output()?;
        if !output.status.success() {
            return Err(command_error("commit", &output));
        }
        // SOURCE_HISTORY_LOCK is held, so HEAD is the commit just made. Read it
        // directly instead of searching the shared history for the path.
        let head = self.run_git_text(&["log", "-1", HISTORY_FORMAT_ARG, "HEAD"])?;
        parse_history_lines(&head, Some(relative_path))?
            .into_iter()
            .next()
            .ok_or_else(|| io_error("Git commit completed without a readable checkpoint"))
    }

    pub(super) fn read_unlocked(
        &self,
        relative_path: &str,
        version_id: &str,
    ) -> std::io::Result<Option<String>> {
        if !self.is_repository() {
            return Ok(None);
        }
        let spec = format!("{version_id}:{relative_path}");
        // Keep the revision and path in one validated `commit:path` argument.
        // Passing it after `--` would make Git interpret it as a pathspec rather
        // than a revision on some versions.
        let mut command = git_command(self.root);
        command.arg("show").arg(spec).current_dir(self.root);
        let output = command.output()?;
        if !output.status.success() {
            return Ok(None);
        }
        String::from_utf8(output.stdout)
            .map(Some)
            .map_err(|error| io_error(format!("Git history is not UTF-8: {error}")))
    }

    /// Like [`Self::read_unlocked`], but only a path the commit's tree does not
    /// hold is `None` (deleted at that commit). A path the tree lists whose
    /// content Git cannot produce (a missing or damaged object) is an error, so
    /// the import stops and keeps `.git` instead of dropping that version.
    pub(super) fn read_for_import(
        &self,
        relative_path: &str,
        version_id: &str,
    ) -> std::io::Result<Option<String>> {
        if let Some(content) = self.read_unlocked(relative_path, version_id)? {
            return Ok(Some(content));
        }
        let mut command = git_command(self.root);
        command
            .args(["ls-tree", "-z", version_id, "--"])
            .arg(relative_path)
            .current_dir(self.root);
        let output = command.output()?;
        if !output.status.success() {
            return Err(io_error(format!(
                "Git history cannot list {relative_path} at {version_id}"
            )));
        }
        if output.stdout.is_empty() {
            return Ok(None);
        }
        Err(io_error(format!(
            "Git history cannot read {relative_path} at {version_id}"
        )))
    }

    pub(super) fn head(&self) -> std::io::Result<Option<String>> {
        let mut command = git_command(self.root);
        command
            .args(["rev-parse", "--verify", "--quiet", "HEAD"])
            .current_dir(self.root);
        let output = command.output()?;
        if !output.status.success() {
            return Ok(None);
        }
        let head = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        Ok((!head.is_empty()).then_some(head))
    }

    /// Commits reachable from `head` and not from `since`, oldest first, with
    /// the paths each one records (changed files plus its source-path trailer).
    pub(super) fn commits(
        &self,
        since: Option<&str>,
        head: &str,
    ) -> std::io::Result<Vec<LegacyCommit>> {
        let range = match since {
            Some(since) => format!("{since}..{head}"),
            None => head.to_owned(),
        };
        let raw = self.run_git_text(&[
            "log",
            "--reverse",
            "--date=unix",
            "--format=%H%x1f%ct%x1f%s%x1f%b%x1e",
            &range,
        ])?;
        let mut commits = Vec::new();
        for record in raw
            .split('\u{1e}')
            .map(|record| record.trim_start_matches(['\n', '\r']))
            .filter(|record| !record.trim().is_empty())
        {
            let mut fields = record.splitn(4, '\u{1f}');
            let (Some(id), Some(timestamp), Some(subject)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let body = fields.next().unwrap_or_default();
            let created_at = timestamp
                .parse::<i64>()
                .map(|seconds| seconds.saturating_mul(1000))
                .map_err(|_| io_error("Git history returned an invalid timestamp"))?;
            let mut paths: Vec<String> = Vec::new();
            let changed = self.run_git_text(&[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-only",
                "-r",
                "-z",
                id,
            ])?;
            for path in changed.split('\0').filter(|path| !path.is_empty()) {
                if !paths.iter().any(|known| known == path) {
                    paths.push(path.to_owned());
                }
            }
            for line in body.lines() {
                if let Some(path) = line.trim().strip_prefix(SOURCE_PATH_TRAILER) {
                    let path = path.trim();
                    if !path.is_empty() && !paths.iter().any(|known| known == path) {
                        paths.push(path.to_owned());
                    }
                }
            }
            commits.push(LegacyCommit {
                id: id.to_owned(),
                created_at,
                subject: subject.to_owned(),
                paths,
            });
        }
        Ok(commits)
    }

    pub(super) fn ensure_repository(&self) -> std::io::Result<()> {
        if self.is_repository() {
            return Ok(());
        }
        std::fs::create_dir_all(self.root)?;
        let mut command = git_command(self.root);
        command.args(["init", "-b", "main"]).current_dir(self.root);
        let output = command.output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(command_error("init", &output))
        }
    }

    pub(super) fn is_repository(&self) -> bool {
        self.root.join(".git").is_dir()
    }

    pub(super) fn run_git(&self, args: &[&str]) -> std::io::Result<()> {
        let mut command = git_command(self.root);
        command.args(args).current_dir(self.root);
        let output = command.output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(command_error(
                args.first().copied().unwrap_or("Git"),
                &output,
            ))
        }
    }

    pub(super) fn run_git_status(&self, args: &[&str]) -> std::io::Result<i32> {
        let mut command = git_command(self.root);
        command.args(args).current_dir(self.root);
        Ok(command.output()?.status.code().unwrap_or(1))
    }

    pub(super) fn run_git_text(&self, args: &[&str]) -> std::io::Result<String> {
        let mut command = git_command(self.root);
        command.args(args).current_dir(self.root);
        let output = command.output()?;
        if output.status.success() {
            String::from_utf8(output.stdout)
                .map_err(|error| io_error(format!("Git output is not UTF-8: {error}")))
        } else if args.first().copied() == Some("log")
            && String::from_utf8_lossy(&output.stderr).contains("does not have any commits yet")
        {
            Ok(String::new())
        } else {
            Err(command_error(
                args.first().copied().unwrap_or("Git"),
                &output,
            ))
        }
    }

    pub(super) fn latest_for_path(
        &self,
        relative_path: &str,
    ) -> std::io::Result<Option<SourceHistoryVersion>> {
        Ok(self.list_unlocked(relative_path, 1)?.into_iter().next())
    }

    pub(super) fn list_unlocked(
        &self,
        relative_path: &str,
        limit: usize,
    ) -> std::io::Result<Vec<SourceHistoryVersion>> {
        if !self.is_repository() {
            return Ok(Vec::new());
        }
        // Both logs are newest-first and bounded to `limit`, so the newest
        // `limit` entries of their union are always inside the two bounded sets.
        // The repository is shared by every source kind, so an unbounded scan
        // would make each checkpoint cost grow with total history.
        let count = limit.to_string();
        let trailer_grep = format!("--grep={SOURCE_PATH_TRAILER} {relative_path}");
        let trailer_args = [
            "log",
            "--fixed-strings",
            trailer_grep.as_str(),
            HISTORY_FORMAT_ARG,
        ];
        // `--fixed-strings` keeps regex metacharacters in paths literal, but it
        // is a substring match (`a.json` also matches `a.json.bak`). Those false
        // positives are dropped by the exact trailer filter in the parser; when
        // they fill the bounded window, rescan without the bound.
        let bounded = self.run_git_text(&[&trailer_args[..], &["-n", count.as_str()]].concat())?;
        let mut versions = parse_history_lines(&bounded, Some(relative_path))?;
        if versions.len() < limit && history_record_count(&bounded) >= limit {
            let all_matches = self.run_git_text(&trailer_args)?;
            versions = parse_history_lines(&all_matches, Some(relative_path))?;
        }
        let path_commits = self.run_git_text(&[
            "log",
            HISTORY_FORMAT_ARG,
            "-n",
            count.as_str(),
            "--",
            relative_path,
        ])?;
        let mut seen = versions
            .iter()
            .map(|version| version.id.clone())
            .collect::<HashSet<_>>();
        for version in parse_history_lines(&path_commits, None)? {
            if seen.insert(version.id.clone()) {
                versions.push(version);
            }
        }
        versions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        versions.truncate(limit);
        Ok(versions)
    }
}

/// Owner-only permissions for a history file.
#[cfg(unix)]
pub(super) fn restrict_to_owner(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
pub(super) fn restrict_to_owner(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub(super) fn restrict_dir_to_owner(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
pub(super) fn restrict_dir_to_owner(_path: &Path) {}

pub(super) fn source_history_lock() -> std::io::Result<MutexGuard<'static, ()>> {
    SOURCE_HISTORY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| io_error("source history lock is poisoned"))
}

pub(super) fn git_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg(format!(
            "core.hooksPath={}",
            if cfg!(windows) { "NUL" } else { "/dev/null" }
        ))
        .no_window()
        .current_dir(root);
    ryu_crypto::scrub_seal_env(&mut command);
    command
}

pub(super) fn history_record_count(raw: &str) -> usize {
    raw.split('\u{1e}')
        .filter(|record| !record.trim().is_empty())
        .count()
}

pub(super) fn parse_history_lines(
    raw: &str,
    source_path: Option<&str>,
) -> std::io::Result<Vec<SourceHistoryVersion>> {
    let mut versions = Vec::new();
    for record in raw
        .split('\u{1e}')
        .map(|record| record.trim_start_matches(['\n', '\r']))
        .filter(|record| !record.trim().is_empty())
    {
        let mut fields = record.splitn(4, '\u{1f}');
        let Some(id) = fields.next() else {
            continue;
        };
        let Some(timestamp) = fields.next() else {
            continue;
        };
        let Some(label) = fields.next() else {
            continue;
        };
        let body = fields.next().unwrap_or_default();
        if let Some(source_path) = source_path {
            let expected = format!("{SOURCE_PATH_TRAILER} {source_path}");
            if !body.lines().any(|line| line.trim() == expected) {
                continue;
            }
        }
        let created_at = timestamp
            .parse::<i64>()
            .map(|seconds| seconds.saturating_mul(1000))
            .map_err(|_| io_error("Git history returned an invalid timestamp"))?;
        versions.push(SourceHistoryVersion {
            created_at,
            id: id.to_owned(),
            label: Some(label.to_owned()),
        });
    }
    Ok(versions)
}

pub(super) fn validate_relative_path(path: &str) -> std::io::Result<()> {
    let relative = Path::new(path);
    if path.is_empty()
        || path.len() > MAX_HISTORY_PATH_BYTES
        || relative.is_absolute()
        || path.chars().any(char::is_control)
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(io_error(
            "source history path must stay inside the repository",
        ));
    }
    Ok(())
}

pub(super) fn validate_version_id(id: &str) -> std::io::Result<()> {
    if id.len() < 7 || id.len() > 64 || !id.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(io_error("source history version id is invalid"));
    }
    Ok(())
}

pub(super) fn commit_subject(label: Option<&str>) -> String {
    let label = label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Checkpoint")
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    label.chars().take(MAX_HISTORY_LABEL_BYTES).collect()
}

pub(super) fn command_error(operation: &str, output: &std::process::Output) -> std::io::Error {
    let details = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(400)
        .collect::<String>();
    if details.is_empty() {
        io_error(operation.to_owned())
    } else {
        io_error(format!("{operation}: {details}"))
    }
}

pub(super) fn sql_error(error: rusqlite::Error) -> std::io::Error {
    io_error(format!("source history database: {error}"))
}

pub(super) fn io_error(message: impl Into<String>) -> std::io::Error {
    std::io::Error::other(message.into())
}
