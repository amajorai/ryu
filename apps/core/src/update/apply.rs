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
//! Trust: the bytes must match GitHub's published per-asset digest; once a
//! publisher key is compiled in, they must also match the release's signed
//! `SHA256SUMS` (see `apply_trust.rs`), and the staged file is re-hashed right
//! before any swap.
//!
//! Platform note: on Windows a running `.exe` cannot be overwritten in place, so
//! the self-replace renames the live binary aside (`*.old`) and moves the new
//! one into its slot — the classic rename-then-replace. The `.old` file is
//! cleaned up on the next launch.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;

use super::ReleaseAsset;
use crate::downloads::{DownloadCenter, DownloadKind, DownloadRole, DownloadSpec};
pub use outcome::ApplyOutcome;
use release::release_tag;
pub use swap::cleanup_stale_backup;
use swap::{replace_current_exe, replace_exe_at, running_inside_app_bundle};
use trust::{ensure_staged_digest, ReleaseTrust};

#[path = "apply_outcome.rs"]
mod outcome;
#[path = "apply_release.rs"]
mod release;
#[path = "apply_signature.rs"]
mod signature;
#[path = "apply_swap.rs"]
mod swap;
#[path = "apply_trust.rs"]
mod trust;

/// Where downloaded update artifacts are staged before install.
fn staging_dir() -> PathBuf {
    crate::paths::cache_path("updates")
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
    /// Human-readable next step, rendered in the node's locale.
    pub message: String,
    /// Stable id of `message` (see [`ApplyOutcome::id`]), so a client can word
    /// the outcome itself.
    pub message_id: &'static str,
    /// The raw values `message` interpolates (`kind`, `detail`); never translated.
    pub message_values: BTreeMap<&'static str, String>,
    /// Core was swapped but the Gateway it launches could not be. Restarting
    /// now would pair the new Core with the old Gateway, so an unattended
    /// restart must not happen. In-process only.
    #[serde(skip)]
    pub gateway_left_behind: bool,
}

/// The Gateway binary the running Core launches: `RYU_GATEWAY_BIN`, else
/// `ryu-gateway` on `PATH` — the same resolution `sidecar::gateway` spawns with.
fn managed_gateway_path() -> Option<PathBuf> {
    let configured = std::env::var("RYU_GATEWAY_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let path = match configured {
        Some(path) => PathBuf::from(path),
        None => crate::sidecar::manifest_sidecar::which_on_path("ryu-gateway")?,
    };
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    (path.is_file() && !path.to_string_lossy().contains(".app/Contents/")).then_some(path)
}

/// Replace the Gateway alongside a Core self-update.
///
/// Core and the Gateway ship on ONE release train and Core refuses a Gateway
/// whose version disagrees, so swapping Core alone left a remote node with a
/// stale Gateway after every update. The Gateway asset comes from the SAME
/// release as the Core asset just installed and is verified the same way
/// (the same [`ReleaseTrust`], so the same signed manifest when a key exists).
/// Best-effort: the Core swap already succeeded, so a Gateway failure is
/// reported in the message rather than undoing it.
async fn update_gateway_alongside(
    downloads: &DownloadCenter,
    trust: &ReleaseTrust,
) -> std::result::Result<Option<PathBuf>, String> {
    let Some(gateway) = managed_gateway_path() else {
        return Ok(None);
    };
    let name = format!(
        "ryu-gateway-{}{}",
        super::platform_tag(),
        std::env::consts::EXE_SUFFIX
    );
    let asset = trust.asset_named(&name).map_err(|e| format!("{e:#}"))?;
    let digest = trust.digest_for(&asset).map_err(|e| format!("{e:#}"))?;
    let staged = downloads
        .download_blocking(DownloadSpec {
            kind: DownloadKind::Other,
            role: DownloadRole::Other,
            label: format!("Ryu update ({name})"),
            url: asset.url.clone(),
            dest: staging_dir().join(&name),
            sha256: Some(digest.clone()),
            version_record: None,
        })
        .await
        .map_err(|e| format!("downloading {name}: {e:#}"))?;
    ensure_staged_digest(&staged, &digest).map_err(|e| format!("{e:#}"))?;
    replace_exe_at(&gateway, &staged).map_err(|e| format!("{e:#}"))?;
    let _ = std::fs::remove_file(&staged);
    Ok(Some(gateway))
}

/// Download `asset` into the staging dir. Returns the staged file path.
///
/// Goes through the global [`crate::downloads::DownloadCenter`] rather than a bare
/// `reqwest` GET. This is the largest single transfer Core ever performs — a whole
/// release binary or installer — and it used to buffer the entire body in memory
/// with no row anywhere, so a headless `POST /api/update/apply` looked hung for
/// minutes. The center streams it to `<dest>.part`, publishes byte progress to the
/// Downloads page and tray, and makes it pausable/resumable/cancelable like every
/// other artifact.
async fn download_asset(
    downloads: &DownloadCenter,
    asset: &ReleaseAsset,
    digest: &str,
) -> Result<PathBuf> {
    let dir = staging_dir();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating staging dir {}", dir.display()))?;

    downloads
        .download_blocking(DownloadSpec {
            kind: DownloadKind::Other,
            role: DownloadRole::Other,
            label: format!("Ryu update ({})", asset.name),
            url: asset.url.clone(),
            dest: dir.join(&asset.name),
            // DownloadCenter verifies bytes against independently fetched metadata.
            sha256: Some(digest.to_owned()),
            version_record: None,
        })
        .await
        .context("downloading update asset")
}

/// Apply an update from a resolved [`ReleaseAsset`].
///
/// - For a raw executable/archive (`exe`/`archive`) we perform the headless
///   self-replace and report `restart_required`.
/// - For OS installers (`msi`/`dmg`/`deb`/`appimage`) we stage the file and hand
///   the path back; the client runs the platform installer (Core does not launch
///   GUI installers itself).
pub async fn apply_update(downloads: &DownloadCenter, asset: &ReleaseAsset) -> Result<ApplyResult> {
    let trust = ReleaseTrust::load(&release_tag(asset)?).await?;
    let digest = trust.digest_for(asset)?;
    let staged = download_asset(downloads, asset, &digest).await?;
    // Re-hash what is on disk now: the swap (or installer hand-off) below must
    // only ever see bytes that match the verified digest.
    ensure_staged_digest(&staged, &digest)?;
    let staged_str = staged.display().to_string();

    match asset.kind.as_str() {
        // This platform's standalone Core binary — the asset `/api/update/check`
        // offers — is swapped directly on every OS. Any other `exe` (an installer,
        // another release binary) is only staged: swapping it in as Core would
        // replace this process with a different program.
        "exe" if asset.name == super::core_asset_name() && !running_inside_app_bundle() => {
            replace_current_exe(&staged)?;
            let gateway = update_gateway_alongside(downloads, &trust).await;
            let gateway_left_behind = gateway.is_err();
            let outcome = match gateway {
                Ok(Some(_)) => ApplyOutcome::InstalledWithGateway,
                Ok(None) => ApplyOutcome::Installed,
                Err(error) => {
                    tracing::warn!("update: Core updated but the Gateway was not: {error}");
                    ApplyOutcome::GatewayLeftBehind {
                        detail: error.to_string(),
                    }
                }
            };
            Ok(ApplyResult::new(true, staged_str, outcome, gateway_left_behind).await)
        }
        "msi" | "dmg" | "deb" | "appimage" => Ok(ApplyResult::new(
            false,
            staged_str,
            ApplyOutcome::RunInstaller {
                kind: asset.kind.clone(),
            },
            false,
        )
        .await),
        "archive" | "exe" => {
            Ok(ApplyResult::new(false, staged_str, ApplyOutcome::ReplaceBinary, false).await)
        }
        other => Err(anyhow!("unsupported update asset kind: {other}")),
    }
}

#[cfg(test)]
#[path = "apply_tests.rs"]
mod tests;
