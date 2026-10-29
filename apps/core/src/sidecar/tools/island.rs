//! Ryu Island companion bundle downloader.
//!
//! Island is not a Core sidecar: Core never launches it and it is deliberately
//! absent from the node selector while the companion is disabled. Core still owns
//! the bytes because its DownloadCenter is the single resumable, observable
//! download path shared by Desktop and the one-line installer.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result};

use crate::downloads::{DownloadCenter, DownloadKind, DownloadRole, DownloadSpec, VersionRecord};
use crate::sidecar::download_manager::{
    build_http_client, fetch_sibling_sha256, sha256_sibling_url, VersionStore,
};

const RELEASE_BASE: &str = "https://github.com/amajorai/ryu/releases/latest/download";
const RELEASE_URL_ENV: &str = "RYU_ISLAND_RELEASE_URL";
const ALLOW_UNVERIFIED_ENV: &str = "RYU_ALLOW_UNVERIFIED_ISLAND";
const VERSION_MARKER: &str = ".version";
const VERSION_STORE_KEY: &str = "island";

fn install_dir() -> PathBuf {
    crate::paths::bin_dir().join("island")
}

fn version_path() -> PathBuf {
    install_dir().join(VERSION_MARKER)
}

/// The launch target inside the managed Island directory.
pub fn install_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "ryu-island.exe"
    } else if cfg!(target_os = "macos") {
        "Ryu Island.app"
    } else {
        "ryu-island.AppImage"
    };
    install_dir().join(name)
}

/// Whether the final managed target exists. This intentionally does not inspect
/// the marker: the setup/list endpoint uses it to report physical reality even
/// while a version refresh is in flight.
pub fn is_installed_on_disk() -> bool {
    install_path().exists()
}

/// Electron-builder's artifact names for the portable targets Desktop can manage.
/// The interactive Windows installer, macOS dmg, and Linux deb are intentionally
/// excluded: none is a detached companion launch target.
pub fn asset_name() -> Option<&'static str> {
    asset_name_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn asset_name_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("ryu-island-win-x64-portable.exe"),
        ("linux", "x86_64") => Some("ryu-island-linux-x86_64.AppImage"),
        ("macos", "aarch64") => Some("ryu-island-mac-arm64.zip"),
        _ => None,
    }
}

fn asset_url(asset: &str) -> String {
    asset_url_for(std::env::var(RELEASE_URL_ENV).ok().as_deref(), asset)
}

fn asset_url_for(override_url: Option<&str>, asset: &str) -> String {
    if let Some(override_url) = override_url.map(str::trim).filter(|url| !url.is_empty()) {
        return override_url.to_owned();
    }
    format!("{RELEASE_BASE}/{asset}")
}

fn allow_unverified_download(debug_build: bool, value: Option<&str>) -> bool {
    debug_build
        && value
            .map(str::trim)
            .is_some_and(|value| matches!(value, "1" | "true" | "yes" | "on"))
}

fn marker_matches(expected_version: &str) -> bool {
    std::fs::read_to_string(version_path())
        .map(|value| value.trim() == expected_version)
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn replace_file(downloaded: &Path, target: &Path) -> Result<()> {
    let backup = target.with_extension("previous");
    if backup.exists() {
        std::fs::remove_file(&backup)
            .with_context(|| format!("remove old Island backup {}", backup.display()))?;
    }
    if target.exists() {
        std::fs::rename(target, &backup)
            .with_context(|| format!("stage existing Island bundle {}", target.display()))?;
    }
    if let Err(error) = std::fs::rename(downloaded, target) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, target);
        }
        return Err(error).with_context(|| format!("install Island bundle {}", target.display()));
    }
    if backup.exists() {
        std::fs::remove_file(&backup)
            .with_context(|| format!("remove old Island bundle {}", backup.display()))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn extract_macos_zip(archive: &Path, dir: &Path) -> Result<PathBuf> {
    let staging = dir.join(".staging");
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .with_context(|| format!("remove Island staging dir {}", staging.display()))?;
    }
    std::fs::create_dir_all(&staging)
        .with_context(|| format!("create Island staging dir {}", staging.display()))?;

    let extracted = std::process::Command::new("ditto")
        .args(["-x", "-k"])
        .arg(archive)
        .arg(&staging)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
        || std::process::Command::new("unzip")
            .args(["-o"])
            .arg(archive)
            .arg("-d")
            .arg(&staging)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    if !extracted {
        let _ = std::fs::remove_dir_all(&staging);
        anyhow::bail!("failed to extract Ryu Island archive");
    }

    let bundle = std::fs::read_dir(&staging)
        .context("read extracted Island bundle")?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("app"))
        .ok_or_else(|| anyhow::anyhow!("no .app found in Ryu Island archive"))?;
    let target = install_path();
    let backup = dir.join("Ryu Island.previous.app");
    if backup.exists() {
        std::fs::remove_dir_all(&backup)
            .with_context(|| format!("remove old Island backup {}", backup.display()))?;
    }
    if target.exists() {
        std::fs::rename(&target, &backup)
            .with_context(|| format!("stage existing Island bundle {}", target.display()))?;
    }
    if let Err(error) = std::fs::rename(&bundle, &target) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error).with_context(|| format!("install Island bundle {}", target.display()));
    }
    if backup.exists() {
        std::fs::remove_dir_all(&backup)
            .with_context(|| format!("remove old Island bundle {}", backup.display()))?;
    }
    std::fs::remove_dir_all(&staging)
        .with_context(|| format!("remove Island staging dir {}", staging.display()))?;
    Ok(target)
}

/// Download and install the managed Island target through Core's global
/// DownloadCenter. `force` is used by the update endpoint; a normal preinstall
/// is marker-idempotent and does not touch an already-current bundle.
pub async fn ensure_installed(
    downloads: &DownloadCenter,
    expected_version: &str,
    force: bool,
) -> Result<PathBuf> {
    static INSTALL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = INSTALL_LOCK
        .get_or_init(|| tokio::sync::Mutex::const_new(()))
        .lock()
        .await;

    let expected_version = expected_version.trim();
    if expected_version.is_empty() {
        anyhow::bail!("Island install requires a non-empty version marker");
    }
    if !force && is_installed_on_disk() && marker_matches(expected_version) {
        return Ok(install_path());
    }

    let asset = asset_name().ok_or_else(|| {
        anyhow::anyhow!(
            "no prebuilt Ryu Island for {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let dir = install_dir();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create Island install dir {}", dir.display()))?;
    let url = asset_url(asset);

    // A forced refresh clears the previous checksum record so DownloadCenter's
    // checksum fast path cannot mistake the old bundle for the requested update.
    if force || !marker_matches(expected_version) {
        VersionStore::remove_persisted(VERSION_STORE_KEY)
            .context("clear the previous Island version record")?;
    }

    let sha256 = match fetch_sibling_sha256(&build_http_client(), &url).await {
        Some(sha256) => Some(sha256),
        None if allow_unverified_download(
            cfg!(debug_assertions),
            std::env::var(ALLOW_UNVERIFIED_ENV).ok().as_deref(),
        ) =>
        {
            tracing::warn!(
				"Island has no usable sibling checksum at {} — downloading unverified because {} is enabled in a debug build",
				sha256_sibling_url(&url),
				ALLOW_UNVERIFIED_ENV
			);
            None
        }
        None => anyhow::bail!(
			"Island release has no usable sibling checksum at {}; refusing to install unverified bytes",
			sha256_sibling_url(&url)
		),
    };

    #[cfg(target_os = "macos")]
    let archive_dest = dir.join("island-latest.zip");
    #[cfg(not(target_os = "macos"))]
    let archive_dest = install_path().with_extension("download");
    let archive_path = downloads
        .download_blocking(DownloadSpec {
            kind: DownloadKind::Tool,
            role: DownloadRole::Plugin,
            label: "Ryu Island".to_owned(),
            url,
            dest: archive_dest,
            sha256,
            version_record: Some(VersionRecord {
                store_key: VERSION_STORE_KEY.to_owned(),
                version: expected_version.to_owned(),
            }),
        })
        .await
        .context("downloading Ryu Island through the global DownloadCenter")?;

    #[cfg(target_os = "macos")]
    let installed = extract_macos_zip(&archive_path, &dir)?;
    #[cfg(not(target_os = "macos"))]
    let installed = {
        let target = install_path();
        replace_file(&archive_path, &target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&target)?.permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&target, permissions)?;
        }
        target
    };

    let marker_tmp = version_path().with_extension("version.tmp");
    std::fs::write(&marker_tmp, expected_version.as_bytes())
        .context("write Island version marker")?;
    std::fs::rename(&marker_tmp, version_path()).context("install Island version marker")?;

    #[cfg(target_os = "macos")]
    let _ = std::fs::remove_file(&archive_path);

    tracing::info!(version = expected_version, path = %installed.display(), "Ryu Island installed");
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_match_electron_builder_portable_targets() {
        assert_eq!(
            super::asset_name_for("windows", "x86_64"),
            Some("ryu-island-win-x64-portable.exe")
        );
        assert_eq!(
            super::asset_name_for("linux", "x86_64"),
            Some("ryu-island-linux-x86_64.AppImage")
        );
        assert_eq!(
            super::asset_name_for("macos", "aarch64"),
            Some("ryu-island-mac-arm64.zip")
        );
        assert_eq!(super::asset_name_for("macos", "x86_64"), None);
    }

    #[test]
    fn release_override_is_used_as_a_full_url() {
        assert_eq!(
            super::asset_url_for(Some("https://example.test/island.zip"), "ignored"),
            "https://example.test/island.zip"
        );
        assert_eq!(
            super::asset_url_for(Some(""), "artifact.zip"),
            format!("{RELEASE_BASE}/artifact.zip")
        );
    }

    #[test]
    fn unverified_downloads_require_an_explicit_debug_only_override() {
        assert!(!allow_unverified_download(false, Some("true")));
        assert!(!allow_unverified_download(true, None));
        assert!(!allow_unverified_download(true, Some("0")));
        assert!(allow_unverified_download(true, Some("yes")));
    }
}
