//! Resume preparation: the record path, folder naming, and the clone or
//! checkout the worktree is built from.

use super::*;

pub(super) fn record_path(roots: &Roots, workspace_id: &str) -> PathBuf {
    roots
        .resumed()
        .join(format!("{}.json", sha256_hex(workspace_id.as_bytes())))
}

pub(super) fn inside(root: &FsPath, path: &FsPath) -> bool {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    path.starts_with(root)
}

pub(super) fn slug(value: &str, max: usize) -> String {
    let slug: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .take(max)
        .collect();
    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() {
        "thread".to_owned()
    } else {
        slug
    }
}

/// Remotes compare without credentials, a trailing slash or `.git`.
pub(super) fn same_remote(left: &str, right: &str) -> bool {
    let normalize = |url: &str| {
        let url = url.trim().trim_end_matches('/');
        url.strip_suffix(".git").unwrap_or(url).to_ascii_lowercase()
    };
    normalize(left) == normalize(right)
}

pub(super) fn stamp_error(error: impl std::fmt::Display) -> Response {
    coded_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        error.to_string(),
    )
}

/// Pick the repository the worktree is added to. New clones are created (and
/// removed again on failure by the caller); existing checkouts are only read.
pub(super) async fn prepare_repository(
    manifest: &RnpWorkspaceManifestV0,
    destination: &RnpWorkspaceDestinationV0,
    roots: &Roots,
) -> Result<(PathBuf, bool), Response> {
    let refused =
        |code: &str, message: String| coded_error(StatusCode::UNPROCESSABLE_ENTITY, code, message);
    let needed: Vec<String> = match &manifest.commits {
        Some(commits) => commits.prerequisites.clone(),
        None => vec![manifest.repo.base_commit.clone()],
    };
    match destination {
        RnpWorkspaceDestinationV0::ExistingCheckout { checkout_path } => {
            let Some(remote) = manifest.repo.remote_url.clone() else {
                return Err(refused(
                    "remote-mismatch",
                    "an existing checkout needs the source's remote URL".to_owned(),
                ));
            };
            let path = std::fs::canonicalize(checkout_path).map_err(|_| {
                refused(
                    "folder-invalid",
                    "the checkout folder does not exist".to_owned(),
                )
            })?;
            if !inside(&roots.home, &path) {
                return Err(coded_error(
                    StatusCode::FORBIDDEN,
                    "folder-invalid",
                    "the checkout must stay inside the node home directory",
                ));
            }
            let root = blocking({
                let path = path.clone();
                move || handoff::inspect_workspace(&path).map(|inspection| inspection.repo_root)
            })
            .await?;
            let origin = handoff::origin_url(&root);
            if !origin
                .as_deref()
                .is_some_and(|origin| same_remote(origin, &remote))
            {
                return Err(refused(
                    "remote-mismatch",
                    "the checkout's origin does not match the handed-off repository".to_owned(),
                ));
            }
            guard_remote_url(&remote)
                .await
                .map_err(|error| coded_error(StatusCode::BAD_GATEWAY, "remote-blocked", error))?;
            let ensure_root = root.clone();
            blocking(move || handoff::ensure_base(&ensure_root, &needed)).await?;
            Ok((root, false))
        }
        RnpWorkspaceDestinationV0::NewClone { folder_name } => {
            let base_name = folder_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "{}-{}",
                        slug(&manifest.repo.name, 80),
                        slug(&manifest.conversation_id, 8)
                    )
                });
            crate::server::git::validate_folder_name(&base_name)
                .map_err(|error| refused("folder-invalid", error))?;
            std::fs::create_dir_all(&roots.handoffs).map_err(stamp_error)?;
            let parent = std::fs::canonicalize(&roots.handoffs).map_err(stamp_error)?;
            if !inside(&roots.home, &parent) {
                return Err(coded_error(
                    StatusCode::FORBIDDEN,
                    "folder-invalid",
                    "the handoff folder must stay inside the node home directory",
                ));
            }
            let folder = (1..=20)
                .map(|attempt| {
                    if attempt == 1 {
                        parent.join(&base_name)
                    } else {
                        parent.join(format!("{base_name}-{attempt}"))
                    }
                })
                .find(|candidate| std::fs::symlink_metadata(candidate).is_err())
                .ok_or_else(|| {
                    coded_error(
                        StatusCode::CONFLICT,
                        "folder-exists",
                        "no free handoff folder name is left",
                    )
                })?;
            match manifest.repo.remote_url.clone() {
                Some(remote) => {
                    guard_remote_url(&remote).await.map_err(|error| {
                        coded_error(StatusCode::BAD_GATEWAY, "remote-blocked", error)
                    })?;
                    let clone_folder = folder.clone();
                    let cloned = blocking(move || {
                        ryu_workspace::git::clone_repository(&remote, &clone_folder)
                            .map_err(HandoffError::Git)?;
                        handoff::ensure_base(&clone_folder, &needed)
                    })
                    .await;
                    if let Err(response) = cloned {
                        let _ = std::fs::remove_dir_all(&folder);
                        return Err(response);
                    }
                }
                None => {
                    // A local-only repository ships its full history.
                    let full_history = manifest
                        .commits
                        .as_ref()
                        .is_some_and(|commits| commits.prerequisites.is_empty());
                    if !full_history {
                        return Err(refused(
                            "remote-required",
                            "the source has no reachable remote and sent no full history"
                                .to_owned(),
                        ));
                    }
                    let init_folder = folder.clone();
                    blocking(move || handoff::init_repository(&init_folder)).await?;
                }
            }
            Ok((folder, true))
        }
    }
}
