use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use tokio::sync::RwLock;

use crate::plugin_manifest::{PluginManifest, PluginManifestLoader};

// ── Write confinement ─────────────────────────────────────────────────────────

/// Validate and return the write target directory for an app id.
///
/// Confinement rules:
/// 1. `id` must not be empty.
/// 2. `id` must not be an absolute path or contain path separators.
/// 3. The canonical target must be a subdirectory of `apps_dir()`.
/// 4. Symlinks that escape the apps dir are rejected.
///
/// On success returns the (not-yet-created) `<apps_dir>/<id>` path.
pub fn validate_write_target(id: &str) -> Result<PathBuf> {
    if id.is_empty() {
        return Err(anyhow!("app id must not be empty"));
    }

    // Reject absolute paths and path-separator characters to prevent traversal.
    if id.starts_with('/') || id.starts_with('\\') || id.starts_with('.') {
        return Err(anyhow!(
            "app id '{id}' must not start with a path separator or dot"
        ));
    }
    if id.contains('/') || id.contains('\\') {
        return Err(anyhow!("app id '{id}' must not contain path separators"));
    }
    if id.contains("..") {
        return Err(anyhow!("app id '{id}' must not contain '..'"));
    }

    let apps_dir = PluginManifestLoader::plugins_dir();
    let target = apps_dir.join(crate::plugin_manifest::plugin_dir_name(id));

    // If the apps_dir itself doesn't exist yet, we'll create it during write;
    // but the path join is sufficient for confinement checks as long as the id
    // has no traversal components (checked above).
    //
    // If the target already exists, canonicalize and verify confinement.
    if target.exists() {
        let canonical_apps = apps_dir.canonicalize().unwrap_or_else(|_| apps_dir.clone());
        let canonical_target = target.canonicalize().unwrap_or_else(|_| target.clone());
        if !canonical_target.starts_with(&canonical_apps) {
            return Err(anyhow!(
                "app id '{id}' resolves outside the Ryu apps directory (traversal rejected)"
            ));
        }
    }

    Ok(target)
}

// ── Disk write ────────────────────────────────────────────────────────────────

/// Write a manifest to `<plugins_dir>/<manifest.id>/manifest.json` atomically.
/// Creates the directory if it does not exist.
/// Returns the `<plugins_dir>/<manifest.id>` directory path.
pub(super) async fn write_manifest_to_disk(manifest: &PluginManifest) -> Result<PathBuf> {
    let app_dir = validate_write_target(&manifest.id)?;
    let manifest_path = app_dir.join(crate::plugin_manifest::MANIFEST_FILE_NAME);

    let json_bytes = serde_json::to_vec_pretty(manifest).context("serializing manifest to JSON")?;

    // Atomic write: tmp file then rename. Uses write_secret_file for 0o600 on Unix.
    let tmp_path = app_dir.with_extension("ryu.json.tmp");
    tokio::task::spawn_blocking({
        let app_dir = app_dir.clone();
        let tmp_path = tmp_path.clone();
        let manifest_path = manifest_path.clone();
        move || {
            std::fs::create_dir_all(&app_dir)
                .with_context(|| format!("creating app dir {}", app_dir.display()))?;
            write_secret_file(&tmp_path, &json_bytes)?;
            std::fs::rename(&tmp_path, &manifest_path)
                .with_context(|| format!("renaming tmp to {}", manifest_path.display()))?;
            Ok::<_, anyhow::Error>(())
        }
    })
    .await
    .context("write task panicked")??;

    Ok(app_dir)
}

/// Write `data` to `path` with 0o600 permissions on Unix, or plain write on Windows.
pub(super) fn write_secret_file(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write as _;

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .with_context(|| format!("opening {} for write", path.display()))?;
    f.write_all(data)
        .with_context(|| format!("writing to {}", path.display()))?;
    f.sync_all()
        .with_context(|| format!("syncing {}", path.display()))?;
    Ok(())
}

// ── Hot-reload ────────────────────────────────────────────────────────────────

/// Insert or replace the manifest in the shared hot store. A manifest with the
/// same `id` is replaced; a new id is appended.
pub(super) async fn hot_reload_manifest(
    manifest: PluginManifest,
    store: Arc<RwLock<Vec<PluginManifest>>>,
) {
    let mut manifests = store.write().await;
    if let Some(pos) = manifests.iter().position(|m| m.id == manifest.id) {
        manifests[pos] = manifest;
    } else {
        manifests.push(manifest);
    }
}
