//! Managed OpenTunnel CLI installation.
//!
//! OpenTunnel publishes one tarball per Unix platform
//! (`opentunnel-<os>-<arch>.tar.gz`, the layout its own install script reads).
//! The CLI does not build for Windows, so no managed install is offered there.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    bin_dir, compute_sha256, extract_binary_with_libs, VersionStore,
};

/// OpenTunnel release pinned by this Ryu build.
pub const OPENTUNNEL_TARGET_VERSION: &str = "0.3.0";

const RELEASE_BASE: &str = "https://github.com/anomalyco/opentunnel/releases/download/v0.3.0";
const VERSION_KEY: &str = "opentunnel";
const BINARY_NAME: &str = "opentunnel";

#[derive(Debug, Clone, PartialEq, Eq)]
struct Artifact {
    filename: &'static str,
    sha256: &'static str,
    platform: &'static str,
}

/// Core-managed OpenTunnel executable path.
pub(crate) fn managed_path() -> PathBuf {
    bin_dir().join(BINARY_NAME)
}

fn host_artifact(os: &str, arch: &str) -> Option<Artifact> {
    let (filename, sha256, platform) = match (os, arch) {
        ("linux", "x86_64") => (
            "opentunnel-linux-x64.tar.gz",
            "59c4c2adacfbfb525b5a9a5a79dc8af5514cbfcd7cc186bd7d36d8caa1ffdb27",
            "linux-x64",
        ),
        ("linux", "aarch64") => (
            "opentunnel-linux-arm64.tar.gz",
            "b38d17c7971c9b08cafa2ea0105fa056ac2fe83a796c8b0486a033c4286554de",
            "linux-arm64",
        ),
        ("macos", "x86_64") => (
            "opentunnel-darwin-x64.tar.gz",
            "9399434ba22d061235285641fcd657b03a663335de1af33ab5629b1a68cb48fb",
            "darwin-x64",
        ),
        ("macos", "aarch64") => (
            "opentunnel-darwin-arm64.tar.gz",
            "936da191f40dceb011b33298dd72c893143d1524b59a6fe2d6e39beafb48609a",
            "darwin-arm64",
        ),
        _ => return None,
    };
    Some(Artifact {
        filename,
        sha256,
        platform,
    })
}

pub(crate) fn can_install() -> bool {
    host_artifact(std::env::consts::OS, std::env::consts::ARCH).is_some()
}

async fn ensure_installed(downloads: &crate::downloads::DownloadCenter) -> Result<String> {
    let artifact = host_artifact(std::env::consts::OS, std::env::consts::ARCH)
        .context("OpenTunnel is available on macOS and Linux only")?;
    let destination = managed_path();
    let store = VersionStore::load();
    // The recorded checksum is the INSTALLED binary's, so it alone always matches;
    // only skip when the recorded version is also the pinned target, or a bumped
    // pin never upgrades an existing install.
    let recorded_is_target = store
        .versions
        .get(VERSION_KEY)
        .is_some_and(|version| version == OPENTUNNEL_TARGET_VERSION);
    if destination.is_file() && recorded_is_target {
        if let Some(recorded) = store.installed_checksum(VERSION_KEY) {
            if compute_sha256(&destination).await? == recorded {
                return Ok(OPENTUNNEL_TARGET_VERSION.to_owned());
            }
            tracing::warn!("OpenTunnel managed binary checksum mismatch; reinstalling");
        }
    }

    let url = format!("{RELEASE_BASE}/{}", artifact.filename);
    let temporary = crate::sidecar::download_manager::tmp_dir().join(format!(
        "opentunnel-{OPENTUNNEL_TARGET_VERSION}-{}.download",
        artifact.platform
    ));
    let downloaded = downloads
        .download_blocking(crate::downloads::DownloadSpec {
            kind: crate::downloads::DownloadKind::Tool,
            role: crate::downloads::DownloadRole::Tool,
            label: "OpenTunnel".to_owned(),
            url: url.clone(),
            dest: temporary,
            sha256: Some(artifact.sha256.to_owned()),
            version_record: None,
        })
        .await
        .with_context(|| format!("downloading OpenTunnel from {url}"))?;

    let archive = tokio::fs::read(&downloaded)
        .await
        .context("reading the downloaded OpenTunnel archive")?;
    let output_dir = bin_dir();
    let installed = tokio::task::spawn_blocking(move || {
        extract_binary_with_libs(&archive, BINARY_NAME, &output_dir, false)
    })
    .await
    .context("extracting the OpenTunnel archive")??;
    mark_executable(&installed)?;
    let _ = tokio::fs::remove_file(downloaded).await;

    let installed_checksum = compute_sha256(&installed).await?;
    VersionStore::record_persisted(VERSION_KEY, OPENTUNNEL_TARGET_VERSION, &installed_checksum)
        .context("writing OpenTunnel's installed version")?;
    tracing::info!(path = %installed.display(), "OpenTunnel installed");
    Ok(OPENTUNNEL_TARGET_VERSION.to_owned())
}

fn mark_executable(path: &Path) -> Result<()> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

pub(crate) async fn install_opentunnel(
    downloads: &crate::downloads::DownloadCenter,
) -> Result<String> {
    ensure_installed(downloads).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_assets_are_pinned_and_checksum_verified_per_platform() {
        for (os, arch, filename) in [
            ("linux", "x86_64", "opentunnel-linux-x64.tar.gz"),
            ("linux", "aarch64", "opentunnel-linux-arm64.tar.gz"),
            ("macos", "x86_64", "opentunnel-darwin-x64.tar.gz"),
            ("macos", "aarch64", "opentunnel-darwin-arm64.tar.gz"),
        ] {
            let artifact = host_artifact(os, arch).expect("supported platform");
            assert_eq!(artifact.filename, filename);
            assert_eq!(artifact.sha256.len(), 64);
            assert!(artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn windows_and_other_platforms_do_not_offer_a_managed_install() {
        // The OpenTunnel CLI refuses to compile outside Unix.
        assert!(host_artifact("windows", "x86_64").is_none());
        assert!(host_artifact("linux", "arm").is_none());
        assert!(host_artifact("freebsd", "x86_64").is_none());
    }
}
