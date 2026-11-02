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

use anyhow::{anyhow, ensure, Context, Result};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::ReleaseAsset;
use crate::downloads::{DownloadCenter, DownloadKind, DownloadRole, DownloadSpec};
pub use outcome::ApplyOutcome;

#[path = "apply_outcome.rs"]
mod outcome;

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

/// The caller selects an official asset; it cannot select a filesystem path or
/// a download origin. Resolve its digest independently from the release API.
fn release_tag(asset: &ReleaseAsset) -> Result<String> {
    ensure!(
        !asset.name.is_empty()
            && asset.name != "."
            && asset.name != ".."
            && asset
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')),
        "invalid update asset filename"
    );
    ensure!(
        super::asset_kind(&asset.name) == asset.kind && asset.kind != "unknown",
        "invalid update asset kind"
    );
    let prefix = format!("https://github.com/{}/releases/download/", super::RYU_REPO);
    let suffix = asset
        .url
        .strip_prefix(&prefix)
        .context("update must come from the official release repository")?;
    let (tag, name) = suffix
        .split_once('/')
        .context("invalid release asset URL")?;
    ensure!(
        !tag.is_empty()
            && tag
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')),
        "invalid release tag"
    );
    ensure!(
        name == asset.name,
        "update asset URL and filename do not match"
    );
    Ok(tag.to_owned())
}

fn release_digest(asset: &ReleaseAsset, tag: &str, release: &serde_json::Value) -> Result<String> {
    ensure!(
        release.get("draft").and_then(serde_json::Value::as_bool) == Some(false),
        "update release is not published"
    );
    ensure!(
        release.get("tag_name").and_then(serde_json::Value::as_str) == Some(tag),
        "update release tag mismatch"
    );
    let entry = release
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|entry| {
                entry.get("name").and_then(serde_json::Value::as_str) == Some(asset.name.as_str())
                    && entry
                        .get("browser_download_url")
                        .and_then(serde_json::Value::as_str)
                        == Some(asset.url.as_str())
            })
        })
        .context("update asset is not in the published release")?;
    ensure!(
        entry.get("size").and_then(serde_json::Value::as_u64) == Some(asset.size) && asset.size > 0,
        "update asset size mismatch"
    );
    let digest = entry
        .get("digest")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()))
        .context("published update has no valid SHA-256 digest")?;
    Ok(digest.to_ascii_lowercase())
}

async fn verified_digest(asset: &ReleaseAsset) -> Result<String> {
    let tag = release_tag(asset)?;
    let release = fetch_release_metadata(&tag).await?;
    release_digest(asset, &tag, &release)
}

/// The published release `tag`, from the releases API (bounded, https only, no
/// redirects).
async fn fetch_release_metadata(tag: &str) -> Result<serde_json::Value> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("ryu-update-verifier")
        .build()?;
    let mut response = client
        .get(format!(
            "https://api.github.com/repos/{}/releases/tags/{tag}",
            super::RYU_REPO
        ))
        .send()
        .await?
        .error_for_status()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            body.len() + chunk.len() <= 2 * 1024 * 1024,
            "release metadata exceeds size limit"
        );
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}

/// The release asset named `name` in `release`, in [`ReleaseAsset`] form.
fn release_asset_named(release: &serde_json::Value, name: &str) -> Option<ReleaseAsset> {
    let entry = release
        .get("assets")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("name").and_then(serde_json::Value::as_str) == Some(name))?;
    Some(ReleaseAsset {
        name: name.to_owned(),
        url: entry.get("browser_download_url")?.as_str()?.to_owned(),
        kind: "exe".to_owned(),
        size: entry.get("size")?.as_u64()?,
    })
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
/// release as the Core asset just installed and is verified the same way.
/// Best-effort: the Core swap already succeeded, so a Gateway failure is
/// reported in the message rather than undoing it.
async fn update_gateway_alongside(
    downloads: &DownloadCenter,
    core_asset: &ReleaseAsset,
) -> std::result::Result<Option<PathBuf>, String> {
    let Some(gateway) = managed_gateway_path() else {
        return Ok(None);
    };
    let tag = release_tag(core_asset).map_err(|e| e.to_string())?;
    let release = fetch_release_metadata(&tag)
        .await
        .map_err(|e| format!("reading release {tag}: {e}"))?;
    let name = format!(
        "ryu-gateway-{}{}",
        super::platform_tag(),
        std::env::consts::EXE_SUFFIX
    );
    let asset = release_asset_named(&release, &name)
        .ok_or_else(|| format!("release {tag} publishes no {name}"))?;
    let digest = release_digest(&asset, &tag, &release).map_err(|e| e.to_string())?;
    let staged = downloads
        .download_blocking(DownloadSpec {
            kind: DownloadKind::Other,
            role: DownloadRole::Other,
            label: format!("Ryu update ({name})"),
            url: asset.url.clone(),
            dest: staging_dir().join(&name),
            sha256: Some(digest),
            version_record: None,
        })
        .await
        .map_err(|e| format!("downloading {name}: {e:#}"))?;
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
async fn download_asset(downloads: &DownloadCenter, asset: &ReleaseAsset) -> Result<PathBuf> {
    let digest = verified_digest(asset).await?;
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
            sha256: Some(digest),
            version_record: None,
        })
        .await
        .context("downloading update asset")
}

/// In-place replace of the currently running executable.
///
/// The new binary is first copied NEXT TO the live one (`<exe>.new`), so the
/// final step is a same-directory rename even when the staging dir is on another
/// volume. The live binary is then renamed aside to `<exe>.old` (allowed while
/// running, on Windows too) and `<exe>.new` moved into its slot. If that last
/// move fails, the backup is renamed back: a failed update must never leave the
/// node with no Core binary at its own path. The caller must restart the process
/// for the new binary to take effect.
fn replace_current_exe(new_binary: &Path) -> Result<()> {
    let current = std::env::current_exe().context("resolving current exe")?;
    replace_exe_at(&current, new_binary)
}

/// Swap `new_binary` into `current`, never leaving `current` missing.
///
/// The new binary is first copied next to the live one (`<exe>.new`, same
/// volume, so the final step is a rename), and only then is the live binary
/// moved aside. If copying fails (disk full, AV lock) the live exe is untouched;
/// if the final rename fails the original is moved back.
fn replace_exe_at(current: &Path, new_binary: &Path) -> Result<()> {
    let backup = current.with_extension("old");
    let incoming = current.with_extension("new");
    let _ = std::fs::remove_file(&incoming);
    // Copy rather than rename so it works across volumes (the staging dir may be
    // on a different drive).
    std::fs::copy(new_binary, &incoming)
        .with_context(|| format!("staging new exe at {}", incoming.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&incoming, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("marking {} executable", incoming.display()))?;
    }
    // Opened for writing: on Windows `FlushFileBuffers` refuses a read-only handle.
    std::fs::OpenOptions::new()
        .write(true)
        .open(&incoming)
        .and_then(|file| file.sync_all())
        .with_context(|| format!("flushing {}", incoming.display()))?;

    // Best-effort: remove a stale backup from a prior update.
    let _ = std::fs::remove_file(&backup);
    if let Err(error) = std::fs::rename(current, &backup) {
        let _ = std::fs::remove_file(&incoming);
        return Err(error)
            .with_context(|| format!("renaming live exe aside to {}", backup.display()));
    }
    if let Err(error) = std::fs::rename(&incoming, current) {
        // Put the original back so the node still has a binary to start.
        let _ = std::fs::rename(&backup, current);
        let _ = std::fs::remove_file(&incoming);
        return Err(error).with_context(|| format!("installing new exe at {}", current.display()));
    }
    let _ = std::fs::remove_file(new_binary);
    Ok(())
}

/// Whether the running Core lives inside a macOS `.app` bundle (the desktop's
/// bundled sidecar). Swapping a file inside a signed bundle breaks its code
/// signature, and the bundle is the native updater's to replace.
fn running_inside_app_bundle() -> bool {
    std::env::current_exe()
        .map(|exe| exe.to_string_lossy().contains(".app/Contents/"))
        .unwrap_or(false)
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
pub async fn apply_update(downloads: &DownloadCenter, asset: &ReleaseAsset) -> Result<ApplyResult> {
    let staged = download_asset(downloads, asset).await?;
    let staged_str = staged.display().to_string();

    match asset.kind.as_str() {
        // This platform's standalone Core binary — the asset `/api/update/check`
        // offers — is swapped directly on every OS. Any other `exe` (an installer,
        // another release binary) is only staged: swapping it in as Core would
        // replace this process with a different program.
        "exe" if asset.name == super::core_asset_name() && !running_inside_app_bundle() => {
            replace_current_exe(&staged)?;
            let gateway = update_gateway_alongside(downloads, asset).await;
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
