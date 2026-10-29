//! Source side of a handoff: inspecting the workspace and exporting its
//! unpushed commits and working-tree diff.

use super::*;

/// `git diff --name-status -z` and `--numstat -z` over the same tree pair,
/// merged into one list. Renames are disabled so every path is a plain
/// add/modify/delete that `git apply --numstat` reports back verbatim.
pub(super) fn changed_files(
    root: &Path,
    index: Option<&Path>,
) -> HandoffResult<(Vec<ChangedFile>, u64, u64)> {
    let run = |args: &[&str]| -> HandoffResult<Vec<u8>> {
        let mut command = git_command(root, args);
        if let Some(index) = index {
            command.env("GIT_INDEX_FILE", index);
        }
        let output = run_command(command, "diff")?;
        if !output.status.success() {
            return Err(git_failure("diff", &output));
        }
        Ok(output.stdout)
    };
    let name_status = split_nul(&run(&[
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ignore-submodules=all",
        "--name-status",
        "-z",
        "HEAD",
    ])?);
    let numstat = split_nul(&run(&[
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--ignore-submodules=all",
        "--numstat",
        "-z",
        "HEAD",
    ])?);
    let mut stats = std::collections::HashMap::new();
    let (mut insertions, mut deletions) = (0u64, 0u64);
    for row in &numstat {
        let mut columns = row.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (columns.next(), columns.next(), columns.next())
        else {
            continue;
        };
        let binary = added == "-" || removed == "-";
        insertions += added.parse::<u64>().unwrap_or(0);
        deletions += removed.parse::<u64>().unwrap_or(0);
        stats.insert(path.to_owned(), binary);
    }
    let mut files = Vec::new();
    let mut rows = name_status.into_iter();
    while let (Some(code), Some(path)) = (rows.next(), rows.next()) {
        let status = match code.chars().next() {
            Some('A') => FileStatus::Added,
            Some('D') => FileStatus::Deleted,
            Some('M' | 'T') => FileStatus::Modified,
            _ => continue,
        };
        if is_excluded(&path) {
            continue;
        }
        if !is_safe_repo_relative_path(&path) {
            return Err(HandoffError::Refused(format!(
                "a changed path cannot be handed off safely: {path}"
            )));
        }
        let bytes = (status != FileStatus::Deleted)
            .then(|| std::fs::symlink_metadata(root.join(&path)).ok())
            .flatten()
            .map(|metadata| metadata.len());
        files.push(ChangedFile {
            binary: stats.get(&path).copied().unwrap_or(false),
            sensitive: is_sensitive_path(&path),
            path,
            status,
            bytes,
        });
    }
    Ok((files, insertions, deletions))
}

/// Untracked files from `status --porcelain=v1 -z --untracked-files=all`,
/// which never lists ignored files. Nested repositories appear as one
/// directory entry and are reported as submodules.
pub(super) fn untracked_candidates(root: &Path) -> HandoffResult<Vec<UntrackedCandidate>> {
    let raw = git_ok(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
        ],
    )?;
    let entries = split_nul(&raw);
    let mut candidates = Vec::new();
    let mut index = 0;
    while index < entries.len() {
        let entry = &entries[index];
        index += 1;
        let (code, path) = entry.split_at(entry.len().min(3));
        // Renames and copies carry their source path as the next entry.
        if code.starts_with('R') || code.starts_with('C') {
            index += 1;
        }
        if code != "?? " {
            continue;
        }
        let path = path.to_owned();
        if is_excluded(&path) {
            continue;
        }
        let candidate = |bytes, selectable, reason| UntrackedCandidate {
            sensitive: is_sensitive_path(&path),
            path: path.clone(),
            bytes,
            selectable,
            reason,
        };
        if path.ends_with('/') {
            candidates.push(candidate(0, false, Some(OmissionReason::Submodule)));
            continue;
        }
        if !is_safe_repo_relative_path(&path) {
            candidates.push(candidate(0, false, Some(OmissionReason::UnsafePath)));
            continue;
        }
        let metadata = std::fs::symlink_metadata(root.join(&path))
            .map_err(|_| HandoffError::Git(format!("could not inspect untracked file {path}")))?;
        if metadata.file_type().is_symlink() {
            candidates.push(candidate(0, false, Some(OmissionReason::Symlink)));
        } else if metadata.len() > MAX_UNTRACKED_FILE_BYTES {
            candidates.push(candidate(
                metadata.len(),
                false,
                Some(OmissionReason::TooLarge),
            ));
        } else {
            candidates.push(candidate(metadata.len(), true, None));
        }
    }
    candidates.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(candidates)
}

/// Whether HEAD's commits can be expressed relative to a remote. Without a
/// network remote the destination starts from `git init`, so the bundle
/// carries HEAD's full history.
pub(super) fn unpushed_range(remote_url: Option<&str>) -> &'static [&'static str] {
    if remote_url.is_some() {
        &["HEAD", "--not", "--remotes"]
    } else {
        &["HEAD"]
    }
}

/// Read what a handoff of `cwd` would carry. Writes nothing.
pub fn inspect_workspace(cwd: &Path) -> HandoffResult<WorkspaceInspection> {
    let root = repository_root(cwd)?;
    reject_filters(&root)?;
    let head = git_optional(&root, &["rev-parse", "--verify", "HEAD^{commit}"])
        .ok_or(HandoffError::NotAGitRepository)?;
    let branch = git_optional(&root, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let upstream_ref = git_optional(
        &root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let remote_url = git_optional(&root, &["config", "--get", "remote.origin.url"])
        .and_then(|url| clean_remote_url(&url));
    let mut count_args = vec!["rev-list", "--count"];
    count_args.extend_from_slice(unpushed_range(remote_url.as_deref()));
    let unpushed_commits = git_text(&root, &count_args)?
        .parse::<u32>()
        .map_err(|_| HandoffError::Git("could not count unpushed commits".to_owned()))?;
    let (changed, insertions, deletions) = changed_files(&root, None)?;
    let untracked = untracked_candidates(&root)?;
    if changed.len() + untracked.len() > MAX_MANIFEST_PATHS {
        return Err(HandoffError::TooLarge(format!(
            "more than {MAX_MANIFEST_PATHS} changed or untracked paths"
        )));
    }
    Ok(WorkspaceInspection {
        name: repository_name(remote_url.as_deref(), &root),
        repo_root: root,
        remote_url,
        head,
        branch,
        upstream_ref,
        unpushed_commits,
        changed,
        untracked,
        insertions,
        deletions,
    })
}

/// Prerequisite commits from a bundle header (`-<oid> <comment>` lines).
pub fn bundle_prerequisites(bundle: &Path) -> HandoffResult<Vec<String>> {
    let file = std::fs::File::open(bundle)
        .map_err(|error| HandoffError::Git(format!("could not read bundle: {error}")))?;
    let mut reader = BufReader::new(file.take(1024 * 1024));
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|_| HandoffError::Git("bundle header is unreadable".to_owned()))?;
    if !line.starts_with("# v2 git bundle") && !line.starts_with("# v3 git bundle") {
        return Err(HandoffError::Refused("not a git bundle".to_owned()));
    }
    let mut prerequisites = Vec::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|_| HandoffError::Git("bundle header is unreadable".to_owned()))?;
        let trimmed = line.trim_end_matches('\n');
        if read == 0 || trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix('-') {
            let oid = rest.split(' ').next().unwrap_or_default();
            if !is_hex_commit(oid) {
                return Err(HandoffError::Refused(
                    "bundle prerequisite is invalid".to_owned(),
                ));
            }
            prerequisites.push(oid.to_owned());
        }
    }
    Ok(prerequisites)
}

/// Write the reviewed working tree of `cwd` into `out_dir`.
///
/// `if_head` is the HEAD the reviewer saw; a moved HEAD fails with
/// [`HandoffError::HeadMoved`]. `include_untracked` must name selectable
/// untracked candidates only.
pub fn export_workspace(
    cwd: &Path,
    if_head: &str,
    include_untracked: &[String],
    out_dir: &Path,
) -> HandoffResult<ExportedWorkspace> {
    let inspection = inspect_workspace(cwd)?;
    if inspection.head != if_head {
        return Err(HandoffError::HeadMoved {
            expected: if_head.to_owned(),
            actual: inspection.head,
        });
    }
    let root = inspection.repo_root.clone();
    std::fs::create_dir_all(out_dir)
        .map_err(|error| HandoffError::Git(format!("could not create staging folder: {error}")))?;

    // Untracked selection: every requested path must be a selectable candidate.
    let requested: BTreeSet<&str> = include_untracked.iter().map(String::as_str).collect();
    if requested.len() > MAX_UNTRACKED_COUNT {
        return Err(HandoffError::TooLarge(format!(
            "more than {MAX_UNTRACKED_COUNT} untracked files"
        )));
    }
    let mut selected = Vec::new();
    let mut omitted = Vec::new();
    let mut untracked_total = 0u64;
    for candidate in &inspection.untracked {
        if requested.contains(candidate.path.as_str()) {
            if !candidate.selectable {
                return Err(HandoffError::Refused(format!(
                    "untracked file cannot be handed off: {}",
                    candidate.path
                )));
            }
            untracked_total += candidate.bytes;
            selected.push(candidate.path.clone());
        } else {
            omitted.push(Omission {
                path: candidate.path.clone(),
                reason: candidate.reason.unwrap_or(OmissionReason::NotSelected),
            });
        }
    }
    if selected.len() != requested.len() {
        return Err(HandoffError::Refused(
            "a selected untracked file is no longer untracked; review it again".to_owned(),
        ));
    }
    if untracked_total > MAX_UNTRACKED_TOTAL_BYTES {
        return Err(HandoffError::TooLarge(
            "selected untracked files exceed 4 MiB".to_owned(),
        ));
    }

    // Commits: a bundle of what the remote does not have.
    let commits = if inspection.unpushed_commits == 0 {
        None
    } else {
        let bundle = out_dir.join("commits.bundle");
        let _ = std::fs::remove_file(&bundle);
        let bundle_arg = bundle.to_string_lossy().into_owned();
        let mut args = vec!["bundle", "create", "--quiet", bundle_arg.as_str()];
        args.extend_from_slice(unpushed_range(inspection.remote_url.as_deref()));
        git_ok(&root, &args)?;
        let bytes = file_len(&bundle)?;
        if bytes > MAX_BUNDLE_BYTES {
            let _ = std::fs::remove_file(&bundle);
            return Err(HandoffError::TooLarge(
                "unpushed commits exceed the 32 MiB bundle limit; push them first".to_owned(),
            ));
        }
        Some(ExportedCommits {
            prerequisites: bundle_prerequisites(&bundle)?,
            path: bundle,
            bytes,
            tip: inspection.head.clone(),
            count: inspection.unpushed_commits,
        })
    };

    // Diff: against a private copy of the index so `add -N` never touches the
    // user's staging area.
    let index_path = git_text(&root, &["rev-parse", "--git-path", "index"])?;
    let index_path = root.join(index_path);
    let temporary_index = out_dir.join("handoff.index");
    if index_path.is_file() {
        copy_index_keeping_mtime(&index_path, &temporary_index)
            .map_err(|error| HandoffError::Git(format!("could not copy the index: {error}")))?;
    } else {
        let _ = std::fs::remove_file(&temporary_index);
    }
    let with_index = |args: &[&str]| -> HandoffResult<Vec<u8>> {
        let mut command = git_command(&root, args);
        command.env("GIT_INDEX_FILE", &temporary_index);
        let output = run_command(command, args[0])?;
        if !output.status.success() {
            return Err(git_failure(args[0], &output));
        }
        Ok(output.stdout)
    };
    for chunk in selected.chunks(64) {
        let mut args = vec!["add", "--intent-to-add", "--"];
        args.extend(chunk.iter().map(String::as_str));
        with_index(&args)?;
    }
    let (files, _, _) = changed_files(&root, Some(&temporary_index))?;
    let diff = if files.is_empty() {
        None
    } else {
        let patch = with_index(&[
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--full-index",
            "--ignore-submodules=all",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "HEAD",
        ])?;
        if patch.len() as u64 > MAX_DIFF_BYTES {
            let _ = std::fs::remove_file(&temporary_index);
            return Err(HandoffError::TooLarge(
                "working-tree changes exceed the 8 MiB patch limit".to_owned(),
            ));
        }
        let path = out_dir.join("changes.diff");
        std::fs::write(&path, &patch)
            .map_err(|error| HandoffError::Git(format!("could not write the patch: {error}")))?;
        Some(ExportedDiff {
            bytes: patch.len() as u64,
            path,
            files,
        })
    };
    let _ = std::fs::remove_file(&temporary_index);
    let untracked = diff
        .as_ref()
        .map(|diff| {
            diff.files
                .iter()
                .filter(|file| selected.contains(&file.path))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    Ok(ExportedWorkspace {
        inspection,
        commits,
        diff,
        untracked,
        omitted,
    })
}

pub(super) fn file_len(path: &Path) -> HandoffResult<u64> {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| HandoffError::Git(format!("could not read {}: {error}", path.display())))
}
