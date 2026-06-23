//! Self-update apply path for the headless binaries (core / gateway / cli) that
//! have no native updater of their own.
//!
//! Status: **code-complete, unverified**. The download + staging is exercisable
//! today, but the binary self-replace and the final installer hand-off cannot be
//! end-to-end verified in this session because there are no signed, published
//! Ryu releases yet (the release CI in `.github/workflows/release.yml` must run
//! once, with the signing secrets configured, before this path has real assets
//! to install). Treat the swap as proven only after a real release exists.
//!
//! Platform note: on Windows a running `.exe` cannot be overwritten in place, so
//! the self-replace renames the live binary aside (`*.old`) and moves the new
//! one into its slot — the classic rename-then-replace. The `.old` file is
//! cleaned up on the next launch.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

use super::ReleaseAsset;
use crate::sidecar::download_manager::ryu_dir;

/// Where downloaded update artifacts are staged before install.
fn staging_dir() -> PathBuf {
    ryu_dir().join("updates")
}

/// Outcome of an apply attempt, returned to the client.
#[derive(Serialize)]
pub struct ApplyResult {
    /// `true` when the new binary was swapped into place (headless self-update).
    pub applied: bool,
    /// `true` when the user/host must take a further step (run an installer, or
    /// restart the process to pick up the swapped binary).
    pub restart_required: bool,
    /// Absolute path of the staged artifact on disk.
    pub staged_path: String,
    /// Human-readable next step.
    pub message: String,
}

/// Download `asset` into the staging dir. Returns the staged file path.
async fn download_asset(client: &reqwest::Client, asset: &ReleaseAsset) -> Result<PathBuf> {
    let dir = staging_dir();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating staging dir {}", dir.display()))?;
    let dest = dir.join(&asset.name);

    let bytes = client
        .get(&asset.url)
        .header("User-Agent", "ryu-core/1.0")
        .send()
        .await
        .context("downloading update asset")?
        .error_for_status()
        .context("update asset http error")?
        .bytes()
        .await
        .context("reading update asset body")?;

    // Atomic-ish write: stage to a temp file then rename into place.
    let tmp = dir.join(format!("{}.part", asset.name));
    std::fs::write(&tmp, &bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &dest).with_context(|| format!("finalising {}", dest.display()))?;
    Ok(dest)
}

/// Windows-safe in-place replace of the currently running executable.
///
/// Renames the live binary to `<exe>.old` (allowed even while running) and moves
/// the freshly downloaded binary into the original path. The caller must restart
/// the process for the new binary to take effect.
fn replace_current_exe(new_binary: &Path) -> Result<()> {
    let current = std::env::current_exe().context("resolving current exe")?;
    let backup = current.with_extension("old");
    // Best-effort: remove a stale backup from a prior update.
    let _ = std::fs::remove_file(&backup);
    std::fs::rename(&current, &backup)
        .with_context(|| format!("renaming live exe aside to {}", backup.display()))?;
    // Move the new binary into the original slot. Copy+remove rather than rename
    // so it works across volumes (the staging dir may be on a different drive).
    std::fs::copy(new_binary, &current)
        .with_context(|| format!("installing new exe at {}", current.display()))?;
    let _ = std::fs::remove_file(new_binary);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&current)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&current, perms)?;
    }
    Ok(())
}

/// Clean up the `<exe>.old` backup left by a previous self-update. Called once
/// on Core startup so the staging crumbs don't accumulate.
pub fn cleanup_stale_backup() {
    if let Ok(current) = std::env::current_exe() {
        let backup = current.with_extension("old");
        if backup.exists() {
            let _ = std::fs::remove_file(backup);
        }
    }
}

/// Apply an update from a resolved [`ReleaseAsset`].
///
/// - For a raw executable/archive (`exe`/`archive`) we perform the headless
///   self-replace and report `restart_required`.
/// - For OS installers (`msi`/`dmg`/`deb`/`appimage`) we stage the file and hand
///   the path back; the client runs the platform installer (Core does not launch
///   GUI installers itself).
pub async fn apply_update(client: &reqwest::Client, asset: &ReleaseAsset) -> Result<ApplyResult> {
    let staged = download_asset(client, asset).await?;
    let staged_str = staged.display().to_string();

    match asset.kind.as_str() {
        // A bare binary we can swap directly. (Archive handling — unpacking then
        // locating the inner binary — is intentionally deferred until real
        // release artifacts exist to validate the layout against.)
        "exe" if cfg!(windows) => {
            replace_current_exe(&staged)?;
            Ok(ApplyResult {
                applied: true,
                restart_required: true,
                staged_path: staged_str,
                message: "Update installed. Restart Ryu Core to run the new version.".to_string(),
            })
        }
        "msi" | "dmg" | "deb" | "appimage" => Ok(ApplyResult {
            applied: false,
            restart_required: true,
            staged_path: staged_str,
            message: format!(
                "Update downloaded. Run the {} installer to complete the update.",
                asset.kind
            ),
        }),
        "archive" | "exe" => Ok(ApplyResult {
            applied: false,
            restart_required: true,
            staged_path: staged_str,
            message: "Update downloaded. Extract and replace the binary to complete the update."
                .to_string(),
        }),
        other => Err(anyhow!("unsupported update asset kind: {other}")),
    }
}
