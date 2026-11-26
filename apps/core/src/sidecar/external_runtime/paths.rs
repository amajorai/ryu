//! Pure checks and joins for the names a runtime declaration carries: the asset URL and
//! its file name, the model path, the package-relative source path, and the package copy.
// test-exempt: moved verbatim out of sidecar/external_runtime.rs by the module split; covered by sidecar/external_runtime/tests.rs.

use super::*;

/// Resolve an [`AssetSpec::source`] to a concrete https download URL.
///
/// - `https://…` passes through unchanged (http and other schemes are rejected,
///   matching the AssetSpec contract).
/// - `hf:<owner>/<repo>/<path…>` maps to the Hub resolve URL
///   `https://huggingface.co/<owner>/<repo>/resolve/main/<path…>`. A **file path**
///   is required; a repo-only ref (`hf:<owner>/<repo>`) is rejected — full-repo
///   snapshot needs Hub tree-listing that is not wired here.
///
/// Pure (no I/O), so it is unit-testable without a network.
pub(super) fn resolve_asset_url(source: &str) -> Result<String, ProvisionError> {
    let s = source.trim();
    if let Some(rest) = s.strip_prefix("hf:") {
        let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() < 3 {
            return Err(ProvisionError::UnsupportedAssetSource(format!(
                "{source} (hf refs need a file path: hf:<owner>/<repo>/<path>; \
                 repo-only snapshot is not supported)"
            )));
        }
        let owner = parts[0];
        let repo = parts[1];
        let file_path = parts[2..].join("/");
        return Ok(format!(
            "{HF_RESOLVE_HOST}/{owner}/{repo}/resolve/main/{file_path}"
        ));
    }
    if s.starts_with("https://") {
        return Ok(s.to_owned());
    }
    Err(ProvisionError::UnsupportedAssetSource(source.to_owned()))
}

/// A path component is a plain filename: non-empty, not `.`/`..`, and free of any
/// path separators or NUL.
fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// A relative dir is traversal-safe: not absolute, no drive/UNC prefix, and every
/// component is a normal name (no `..`). `.` segments are tolerated.
pub(super) fn is_safe_rel_dir(rel: &Path) -> bool {
    if rel.is_absolute() {
        return false;
    }
    rel.components().all(|c| {
        matches!(
            c,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

/// Derive the destination path for an asset: `<runtime_dir>/assets/<dest>/<file>`,
/// where `<file>` is the last path segment of `url`. Rejects a traversing
/// destination or an unsafe derived filename (fail-closed). Pure.
pub(super) fn asset_dest(
    runtime_dir: &Path,
    dest_under_runtime: &str,
    url: &str,
) -> Result<PathBuf, ProvisionError> {
    let rel = Path::new(dest_under_runtime.trim());
    if !is_safe_rel_dir(rel) {
        return Err(ProvisionError::UnsafeAssetPath(format!(
            "asset destination '{dest_under_runtime}' must be a traversal-safe relative path"
        )));
    }
    let parsed = url::Url::parse(url)
        .map_err(|e| ProvisionError::UnsupportedAssetSource(format!("{url} ({e})")))?;
    let filename = parsed
        .path_segments()
        .and_then(|segs| segs.last())
        .map(str::to_owned)
        .unwrap_or_default();
    if !is_safe_filename(&filename) {
        return Err(ProvisionError::UnsafeAssetPath(format!(
            "cannot derive a safe filename from '{url}'"
        )));
    }
    // The file name is the last part of a URL from the plugin's manifest. It is
    // joined only through the shared rule, which refuses `:` on every OS, so a
    // name such as `C:x` cannot make the join drop the assets folder.
    let assets_dir = runtime_dir.join("assets").join(rel);
    crate::sidecar::extract_guard::names::append_named(
        &assets_dir,
        &filename,
        "asset file name",
        true,
    )
    .map_err(|error| ProvisionError::UnsafeAssetPath(error.to_string()))
}

/// A repository-relative model path is allowed to contain normal directory
/// components, but never absolute, parent, Windows-prefix, or hidden path
/// components. The allowlist is a write boundary: every component becomes an
/// on-disk path under the sidecar-owned runtime directory.
pub(super) fn is_safe_model_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let filename = lower.rsplit('/').next().unwrap_or_default();
    let license_file = matches!(filename, "license" | "license.txt" | "license.md");
    let known_model_file = license_file
        || [
            ".bin",
            ".cact",
            ".gguf",
            ".json",
            ".model",
            ".msgpack",
            ".onnx",
            ".pt",
            ".pth",
            ".safetensors",
            ".txt",
            ".yaml",
            ".yml",
        ]
        .iter()
        .any(|extension| lower.ends_with(extension));
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains('\\')
        && known_model_file
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
        && Path::new(path)
            .components()
            .all(|component| match component {
                Component::Normal(value) => !value.to_string_lossy().starts_with('.'),
                _ => false,
            })
}

fn is_safe_hf_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment.len() <= 96
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(super) fn validate_model_revision(revision: &str) -> bool {
    !revision.is_empty()
        && revision.len() <= 128
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(super) fn parse_model_source(source: &str) -> Result<(String, String), ProvisionError> {
    let Some(rest) = source.trim().strip_prefix("hf:") else {
        return Err(ProvisionError::InvalidModelSnapshot(format!(
            "'{source}' must use hf:<owner>/<repo>"
        )));
    };
    let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() != 2 || parts.iter().any(|part| !is_safe_hf_segment(part)) {
        return Err(ProvisionError::InvalidModelSnapshot(format!(
            "'{source}' must name exactly one owner and repository"
        )));
    }
    Ok((parts[0].to_owned(), parts[1].to_owned()))
}

pub(super) fn safe_package_path(
    package_root: &Path,
    relative: &str,
) -> Result<PathBuf, ProvisionError> {
    let rel = Path::new(relative.trim());
    if !is_safe_rel_dir(rel) || relative.trim().is_empty() {
        return Err(ProvisionError::UnsafePackagePath(relative.to_owned()));
    }
    let root = fs::canonicalize(package_root)
        .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
    let candidate = root.join(rel);
    let resolved = fs::canonicalize(&candidate)
        .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
    if !resolved.starts_with(&root) {
        return Err(ProvisionError::UnsafePackagePath(relative.to_owned()));
    }
    Ok(resolved)
}

pub(super) fn copy_package_tree(source: &Path, destination: &Path) -> Result<(), ProvisionError> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ProvisionError::UnsafePackagePath(format!(
            "source '{}' must be a directory without symlinks",
            source.display()
        )));
    }

    for entry in fs::read_dir(source)
        .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?
    {
        let entry = entry.map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
        let source_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
        let destination_path = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(ProvisionError::UnsafePackagePath(format!(
                "source tree contains symlink '{}'",
                source_path.display()
            )));
        }
        if file_type.is_dir() {
            fs::create_dir_all(&destination_path).map_err(|error| ProvisionError::Mkdir(error))?;
            copy_package_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
        } else {
            return Err(ProvisionError::UnsafePackagePath(format!(
                "source tree contains unsupported entry '{}'",
                source_path.display()
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
