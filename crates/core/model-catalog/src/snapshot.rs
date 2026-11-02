//! Multi-file snapshot installs and their path guard.

use super::*;

/// Reject a snapshot repo-relative path that isn't a safe weight/config file
/// under the snapshot directory. Unlike [`validate_gguf_filename`] (a single
/// component), a snapshot mirrors a nested repo tree, so multi-component paths
/// are allowed — but every component must be normal: no `..`, no absolute path,
/// no Windows drive/UNC prefix, no leading separator, no leading-dot component.
/// The extension must be one of the format's weight/config extensions. This is a
/// fresh security boundary because each path becomes an on-disk write target.
pub(crate) fn validate_snapshot_path(rel: &str, format: ModelFormat) -> Result<()> {
    use std::path::{Component, Path};

    let lower = rel.to_lowercase();
    if !format
        .weight_extensions()
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        anyhow::bail!("unexpected file in snapshot: {rel}");
    }
    if rel.is_empty() || rel.starts_with('/') || rel.starts_with('\\') {
        anyhow::bail!("unsafe snapshot path: {rel}");
    }
    // Reject backslashes outright so a Windows-style path can't sneak a drive or
    // alternate separator past the component check.
    if rel.contains('\\') {
        anyhow::bail!("unsafe snapshot path: {rel}");
    }
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => {
                if seg.to_string_lossy().starts_with('.') {
                    anyhow::bail!("unsafe snapshot path: {rel}");
                }
            }
            // CurDir/ParentDir/RootDir/Prefix are all rejected.
            _ => anyhow::bail!("unsafe snapshot path: {rel}"),
        }
    }
    Ok(())
}

/// Install a multi-file repo snapshot (safetensors / MLX) for an engine that
/// serves a whole repo directory rather than a single GGUF file. Enumerates the
/// repo's weight + config files via the format-aware tree endpoint, validates
/// each repo-relative path, and downloads each through the shared
/// [`ryu_downloads::DownloadCenter`] (per-file resume + checksum), mirroring
/// the tree under `models/chat/snapshots/<slug>/`. Records one provenance entry.
///
/// Only the default HF path uses this (it has repo-relative paths). Seam sources
/// stay single-file/GGUF.
pub async fn install_snapshot(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    repo_id: &str,
    format: ModelFormat,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<InstallResult> {
    validate_repo_id(repo_id)?;
    if format.is_single_file() {
        anyhow::bail!("install_snapshot called for a single-file format: {repo_id}");
    }

    let tree = fetch_tree_sizes(client, endpoint, repo_id, format).await?;
    if tree.is_empty() {
        anyhow::bail!(
            "no installable {} files found in {repo_id}",
            format.as_str()
        );
    }

    let slug = installed::slugify_repo(repo_id);
    let dir = installed::model_snapshot_dir(&slug);
    let mut total: u64 = 0;

    // Deterministic order so a resumed install is reproducible.
    let mut paths: Vec<&String> = tree.keys().collect();
    paths.sort();

    for rel in paths {
        validate_snapshot_path(rel, format)?;
        let (size_bytes, sha) = tree.get(rel).cloned().unwrap_or((None, None));
        if let Some(b) = size_bytes {
            total += b;
        }
        let dest = dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating snapshot dir {}", parent.display()))?;
        }
        let spec = ryu_downloads::DownloadSpec {
            kind: ryu_downloads::DownloadKind::Model,
            role: ryu_downloads::DownloadRole::ChatModel,
            label: format!("{repo_id} ({rel})"),
            url: format!("{}/{repo_id}/resolve/main/{rel}", endpoint.host),
            dest,
            sha256: sha,
            version_record: Some(ryu_downloads::VersionRecord {
                store_key: format!("snapshot:{slug}:{rel}"),
                version: repo_id.to_string(),
            }),
        };
        downloads
            .download_blocking(spec)
            .await
            .with_context(|| format!("downloading {rel} from {repo_id}"))?;
    }

    installed::record(installed::InstalledModel {
        repo_id: repo_id.to_string(),
        filename: repo_id.to_string(),
        stem: slug,
        size_bytes: (total > 0).then_some(total),
        format,
        // Snapshot (safetensors/MLX) engines resolve their own vision tower from
        // the repo config — the GGUF `mmproj` companion concept does not apply.
        mmproj: None,
        finetune_base: None,
    })?;

    cache_invalidate(repo_id);
    cache_invalidate("list:");

    Ok(InstallResult {
        repo_id: repo_id.to_string(),
        filename: repo_id.to_string(),
        path: dir.to_string_lossy().to_string(),
    })
}

pub(crate) fn models_dir_has(stem: &str) -> bool {
    installed::model_file_path(stem).exists()
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
