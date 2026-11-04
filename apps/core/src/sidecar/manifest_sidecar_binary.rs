//! Binary sidecar install: the per-version install dir, the checksum-verified
//! download, archive extraction and the final `chmod`.
//!
//! The install tree `<plugin_dir>/bin/<version>` sits inside the plugin's own
//! directory, which an enforce-mode sandboxed sidecar can write (and plant
//! symlinks in). Core runs this unsandboxed, before the next spawn, so every
//! path it writes is confined here: `version` must be one plain segment, the
//! directories Core writes through must be real directories, a symlink at a
//! download destination is removed rather than followed, and archives are
//! extracted into a fresh Core-created staging dir with no-follow writes and
//! then swapped into place.

use std::path::{Component, Path, PathBuf};

use super::{make_executable, owning_manifest, screen_https, url_filename};
use crate::plugin_manifest::schema::BinarySpec;

/// Whether a `Local` sidecar `command` names a file Core manages in its bin dir:
/// one plain path segment (not empty, `.` or `..`, no separator or NUL, no
/// Windows drive prefix, not absolute). Anything else is a path the manifest points at, never a file Core
/// downloaded, so uninstall must not join it onto the bin dir and delete it.
pub(super) fn is_managed_bin_name(command: &str) -> bool {
    !command.trim().is_empty()
        && command != "."
        && command != ".."
        && !command.contains(['/', '\\', '\0'])
        && !(cfg!(windows) && command.contains(':'))
        && !Path::new(command).is_absolute()
}

/// The per-version install directory for a binary sidecar:
/// `<plugin_dir>/bin/<version>`. Namespacing by version means bumping `version`
/// re-downloads/re-extracts into a fresh path.
///
/// Fails closed unless `version` is exactly one plain path segment, so an
/// absolute or `..` version cannot move the install outside `<plugin_dir>/bin`
/// (manifest validation enforces the same rule; this is the sink-side check).
pub(super) fn version_dir(plugin_dir: &Path, bin: &BinarySpec) -> anyhow::Result<PathBuf> {
    let mut components = Path::new(&bin.version).components();
    let single_plain_segment = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(segment)), None) if segment == bin.version.as_str()
    );
    if !single_plain_segment
        || bin.version.trim() != bin.version
        || bin.version.contains(['\\', '\0'])
    {
        return Err(anyhow::anyhow!(
            "binary sidecar version '{}' must be a single plain path segment",
            bin.version
        ));
    }
    let base = plugin_dir.join("bin");
    let dir = base.join(&bin.version);
    if dir.parent() != Some(base.as_path()) {
        return Err(anyhow::anyhow!(
            "binary sidecar version '{}' escapes the plugin's bin dir",
            bin.version
        ));
    }
    Ok(dir)
}

/// Require every existing component of `path` below `base` to be a real
/// directory (not a symlink, not a file). Missing components are fine — Core
/// creates them — but a planted link would redirect Core's writes.
pub(super) fn ensure_real_dirs_below(base: &Path, path: &Path) -> anyhow::Result<()> {
    let rel = path
        .strip_prefix(base)
        .map_err(|_| anyhow::anyhow!("{} is not inside {}", path.display(), base.display()))?;
    let mut cursor = base.to_path_buf();
    for component in rel.components() {
        let Component::Normal(name) = component else {
            return Err(anyhow::anyhow!(
                "install path {} is not a plain path below {}",
                path.display(),
                base.display()
            ));
        };
        cursor.push(name);
        match std::fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(anyhow::anyhow!(
                    "refusing to install a sidecar binary through symlink {}",
                    cursor.display()
                ));
            }
            Ok(meta) if !meta.is_dir() => {
                return Err(anyhow::anyhow!(
                    "sidecar install path {} is not a directory",
                    cursor.display()
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(anyhow::anyhow!("inspecting {}: {e}", cursor.display())),
        }
    }
    Ok(())
}

/// Remove a symlink at `path` (never its target) so a download into `path`
/// cannot be redirected. Regular files are left for the checksum fast path.
fn unlink_if_symlink(path: &Path) -> anyhow::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::remove_file(path)
            .map_err(|e| anyhow::anyhow!("removing planted symlink {}: {e}", path.display())),
        _ => Ok(()),
    }
}

/// Prepare a download destination inside `dir`: the directory chain must be
/// real, and neither the destination nor its `.part` file may be a symlink.
fn prepare_download_dest(plugin_dir: &Path, dest: &Path) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        ensure_real_dirs_below(plugin_dir, parent)?;
    }
    unlink_if_symlink(dest)?;
    let mut part = dest.as_os_str().to_os_string();
    part.push(".part");
    unlink_if_symlink(Path::new(&part))
}

/// Whether `exe` is a regular file reached only through real directories.
fn is_regular_install(plugin_dir: &Path, exe: &Path) -> bool {
    let parent_ok = exe
        .parent()
        .is_some_and(|parent| ensure_real_dirs_below(plugin_dir, parent).is_ok());
    parent_ok && std::fs::symlink_metadata(exe).is_ok_and(|meta| meta.file_type().is_file())
}

/// Download (checksum-verified, idempotent) the binary — raw executable or archive
/// — into its versioned install dir, extract if archived, make the executable
/// runnable, and return the path to run.
///
/// **Integrity gate (fail-closed):** a Community-tier plugin's binary sidecar MUST
/// declare a non-empty `sha256` — an arbitrary https URL with no checksum is
/// unverifiable native code, so the spawn is refused, mirroring how
/// [`super::prepare_node_backend`] refuses a `backend_sha256` mismatch. Core-tier
/// (first-party built-in) manifests keep the historical optional-checksum
/// behavior — they are compiled into this binary and reviewed in-repo.
pub(super) async fn ensure_binary(
    plugin_id: &str,
    bin: &BinarySpec,
    plugin_dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
) -> anyhow::Result<PathBuf> {
    let dir = version_dir(plugin_dir, bin)?;
    let sha = bin.sha256.clone().filter(|s| !s.is_empty());
    let community = owning_manifest(plugin_id)
        .map(|manifest| crate::plugins::builtins::tier_for_manifest(&manifest))
        .unwrap_or(crate::plugin_manifest::PluginTier::Community)
        == crate::plugin_manifest::PluginTier::Community;
    if community && sha.is_none() {
        return Err(anyhow::anyhow!(
            "binary sidecar for community plugin '{plugin_id}' declares no sha256 for '{}'; \
             refusing to download/run an unverifiable binary (add a sha256 to the manifest)",
            bin.url
        ));
    }
    ensure_real_dirs_below(plugin_dir, &dir)?;

    let exe = match &bin.archive {
        // ── Raw executable ────────────────────────────────────────────────────
        None => {
            let dest = dir.join(url_filename(&bin.url)?);
            prepare_download_dest(plugin_dir, &dest)?;
            // Idempotency: without a checksum an already-present binary is trusted;
            // with one, DownloadCenter verifies the on-disk file (skip / re-fetch).
            if !(sha.is_none() && dest.exists()) {
                screen_https(&bin.url).await?;
                downloads
                    .download_blocking(crate::downloads::DownloadSpec {
                        kind: crate::downloads::DownloadKind::Other,
                        role: crate::downloads::DownloadRole::Plugin,
                        label: format!("plugin sidecar binary: {}", bin.url),
                        url: bin.url.clone(),
                        dest: dest.clone(),
                        sha256: sha,
                        version_record: None,
                    })
                    .await?;
            }
            dest
        }
        // ── Archive (extract the whole tree so sibling libs stay co-located) ───
        Some(fmt) => {
            let root = dir.join("root");
            // `binary_name` is required + validated for archives; unwrap is safe
            // post-validation but guard anyway (fail-closed, no panic).
            let binary_name = bin
                .binary_name
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("archive sidecar is missing 'binary_name'"))?;
            let exe = root.join(binary_name);
            // Idempotency: once extracted, reuse it — re-reading a multi-hundred-MB
            // archive on every start is not worth it. The checksum guarantee is
            // enforced at install time (below), not on every boot. A tree with a
            // planted symlink on the way to the exe is re-extracted from scratch.
            if !is_regular_install(plugin_dir, &exe) {
                let archive_path = dir.join(url_filename(&bin.url)?);
                prepare_download_dest(plugin_dir, &archive_path)?;
                if !(sha.is_none() && archive_path.exists()) {
                    screen_https(&bin.url).await?;
                    downloads
                        .download_blocking(crate::downloads::DownloadSpec {
                            kind: crate::downloads::DownloadKind::Other,
                            role: crate::downloads::DownloadRole::Plugin,
                            label: format!("plugin sidecar archive: {}", bin.url),
                            url: bin.url.clone(),
                            dest: archive_path.clone(),
                            sha256: sha,
                            version_record: None,
                        })
                        .await?;
                }
                extract_archive(fmt, &archive_path, &dir).await?;
                if !is_regular_install(plugin_dir, &exe) {
                    return Err(anyhow::anyhow!(
                        "archive did not contain the declared binary '{binary_name}'"
                    ));
                }
            }
            exe
        }
    };

    // The chmod follows links, so refuse anything but a regular file here.
    if !std::fs::symlink_metadata(&exe).is_ok_and(|meta| meta.file_type().is_file()) {
        return Err(anyhow::anyhow!(
            "sidecar binary {} is not a regular file",
            exe.display()
        ));
    }
    make_executable(&exe).await;
    Ok(exe)
}

/// Remove whatever is at `path` without following a symlink there.
fn remove_no_follow(path: &Path) -> anyhow::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(e),
    }
    .map_err(|e| anyhow::anyhow!("removing {}: {e}", path.display()))
}

/// Extract `archive_path` (format `fmt`) into `<version_dir>/root` on a blocking
/// thread (the extractors are synchronous + CPU-bound). Preserves the archive's
/// internal directory structure so an executable's sibling libraries land next
/// to it.
///
/// The tree is extracted into a fresh staging directory Core creates itself
/// (with the extractors' no-follow writes), then the old `root` is removed
/// without following links and the staging dir is renamed into place, so links
/// planted in a previous `root` are never written through.
pub(super) async fn extract_archive(
    fmt: &str,
    archive_path: &Path,
    version_dir: &Path,
) -> anyhow::Result<()> {
    let fmt = fmt.to_owned();
    let archive_path = archive_path.to_owned();
    let version_dir = version_dir.to_owned();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let data = std::fs::read(&archive_path)
            .map_err(|e| anyhow::anyhow!("reading archive {}: {e}", archive_path.display()))?;
        use crate::sidecar::download_manager::{
            extract_tar_bz2_to_dir, extract_tar_gz_to_dir, extract_zip_to_dir,
        };
        let staging = version_dir.join(".root-staging");
        remove_no_follow(&staging)?;
        std::fs::create_dir(&staging)
            .map_err(|e| anyhow::anyhow!("creating {}: {e}", staging.display()))?;
        let extracted = match fmt.as_str() {
            "tar.gz" => extract_tar_gz_to_dir(&data, &staging, None).map(drop),
            "tar.bz2" => extract_tar_bz2_to_dir(&data, &staging, None).map(drop),
            "zip" => extract_zip_to_dir(&data, &staging, None).map(drop),
            other => Err(anyhow::anyhow!("unsupported archive format '{other}'")),
        };
        if let Err(e) = extracted {
            let _ = remove_no_follow(&staging);
            return Err(e);
        }
        let root = version_dir.join("root");
        remove_no_follow(&root)?;
        std::fs::rename(&staging, &root)
            .map_err(|e| anyhow::anyhow!("installing {}: {e}", root.display()))
    })
    .await
    .map_err(|e| anyhow::anyhow!("archive extraction task panicked: {e}"))?
}

#[cfg(test)]
#[path = "manifest_sidecar_binary_tests.rs"]
mod tests;
