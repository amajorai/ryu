//! Manifest, file and blob validation, and the remote-URL guard.

use super::*;

pub(super) fn is_hex(value: &str, lengths: &[usize]) -> bool {
    lengths.contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn is_commit(value: &str) -> bool {
    is_hex(value, &[40, 64])
}

pub(super) fn is_sha256(value: &str) -> bool {
    is_hex(value, &[64])
}

pub(super) fn validate_blob(
    blob: &RnpBlobRefV0,
    media_type: &str,
    max: u64,
) -> Result<(), ValidationError> {
    if !is_sha256(&blob.sha256) {
        return Err(ValidationError::invalid("blob digest is invalid"));
    }
    if blob.media_type != media_type {
        return Err(ValidationError::invalid("blob media type is invalid"));
    }
    if blob.bytes > max {
        return Err(ValidationError::too_large("workspace blob is too large"));
    }
    Ok(())
}

pub(super) fn validate_file(file: &RnpWorkspaceFileV0) -> Result<(), ValidationError> {
    if !handoff::is_safe_repo_relative_path(&file.path) {
        return Err(ValidationError::invalid(format!(
            "workspace path is unsafe: {}",
            file.path
        )));
    }
    if !matches!(
        file.status.as_str(),
        "added" | "modified" | "deleted" | "renamed"
    ) {
        return Err(ValidationError::invalid("unsupported file status"));
    }
    Ok(())
}

/// Every rule `parseRnpWorkspaceManifest` applies, enforced again here because
/// the destination is the boundary: the manifest came from another machine.
pub(super) fn validate_manifest(manifest: &RnpWorkspaceManifestV0) -> Result<(), ValidationError> {
    if manifest.version != VERSION {
        return Err(ValidationError::invalid("unsupported continuity version"));
    }
    if !valid_text(&manifest.workspace_id, MAX_ID_BYTES, false)
        || !valid_text(&manifest.conversation_id, MAX_ID_BYTES, false)
    {
        return Err(ValidationError::invalid(
            "workspace and conversation ids are required",
        ));
    }
    if manifest.created_at < 0 {
        return Err(ValidationError::invalid("workspace timestamp is invalid"));
    }
    let repo = &manifest.repo;
    if !valid_text(&repo.name, MAX_LABEL_BYTES, false) {
        return Err(ValidationError::invalid("repository name is invalid"));
    }
    if !is_commit(&repo.base_commit) {
        return Err(ValidationError::invalid("base commit is invalid"));
    }
    for value in [repo.branch.as_deref(), repo.upstream_ref.as_deref()]
        .into_iter()
        .flatten()
    {
        if !valid_text(value, MAX_LABEL_BYTES, false) {
            return Err(ValidationError::invalid("branch name is invalid"));
        }
    }
    if let Some(url) = repo.remote_url.as_deref() {
        crate::server::git::parse_git_clone_url(url).map_err(|error| {
            ValidationError::invalid(format!("remote URL is not allowed: {error}"))
        })?;
    }
    if let Some(commits) = &manifest.commits {
        validate_blob(&commits.blob, MEDIA_BUNDLE, handoff::MAX_BUNDLE_BYTES)?;
        if commits.tip != repo.base_commit {
            return Err(ValidationError::invalid(
                "bundle tip must be the base commit",
            ));
        }
        if commits.prerequisites.len() > MAX_PREREQUISITES
            || !commits.prerequisites.iter().all(|commit| is_commit(commit))
        {
            return Err(ValidationError::invalid("bundle prerequisites are invalid"));
        }
    }
    let diff_files = manifest
        .diff
        .as_ref()
        .map(|diff| diff.files.as_slice())
        .unwrap_or_default();
    if let Some(diff) = &manifest.diff {
        validate_blob(&diff.blob, MEDIA_DIFF, handoff::MAX_DIFF_BYTES)?;
    }
    if diff_files.len() + manifest.omitted.len() > handoff::MAX_MANIFEST_PATHS {
        return Err(ValidationError::too_large("too many workspace paths"));
    }
    for file in diff_files {
        validate_file(file)?;
    }
    if let Some(path) = handoff::first_path_collision(diff_files.iter().map(|f| f.path.as_str())) {
        return Err(ValidationError::invalid(format!(
            "changed paths collide by case or normalization: {path}"
        )));
    }
    if manifest.untracked.len() > handoff::MAX_UNTRACKED_COUNT {
        return Err(ValidationError::too_large("too many untracked files"));
    }
    let diff_paths: BTreeSet<&str> = diff_files.iter().map(|f| f.path.as_str()).collect();
    let mut untracked_paths = BTreeSet::new();
    let mut untracked_bytes = 0u64;
    for file in &manifest.untracked {
        validate_file(file)?;
        if !untracked_paths.insert(file.path.as_str()) {
            return Err(ValidationError::invalid("untracked paths must be unique"));
        }
        if !diff_paths.contains(file.path.as_str()) {
            return Err(ValidationError::invalid(
                "untracked file is missing from the diff",
            ));
        }
        let bytes = file.bytes.unwrap_or(0);
        if bytes > handoff::MAX_UNTRACKED_FILE_BYTES {
            return Err(ValidationError::too_large("untracked file is too large"));
        }
        untracked_bytes = untracked_bytes.saturating_add(bytes);
    }
    if untracked_bytes > handoff::MAX_UNTRACKED_TOTAL_BYTES {
        return Err(ValidationError::too_large("untracked files are too large"));
    }
    let mut omitted = BTreeSet::new();
    for omission in &manifest.omitted {
        if !valid_text(&omission.path, handoff::MAX_PATH_BYTES, false)
            || !omitted.insert(omission.path.as_str())
        {
            return Err(ValidationError::invalid("omitted paths are invalid"));
        }
    }
    if serde_json::to_vec(manifest)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
        > MAX_MANIFEST_JSON_BYTES
    {
        return Err(ValidationError::too_large(
            "workspace manifest is too large",
        ));
    }
    Ok(())
}

/// The SSRF screen for a remote URL that came from another machine: it must
/// parse as a credential-free HTTPS/SSH clone URL and resolve only to public
/// addresses.
pub(crate) async fn guard_remote_url(url: &str) -> Result<(), String> {
    let source = crate::server::git::parse_git_clone_url(url)?;
    crate::server::resolve_guarded_host(&source.host, source.port)
        .await
        .map(|_| ())
}
