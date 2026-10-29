//! Managed Cloudflared Quick Tunnel binary installation.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    bin_dir, compute_sha256, extract_binary_with_libs, VersionStore,
};

/// Cloudflare release pinned by this Ryu build.
pub const CLOUDFLARED_TARGET_VERSION: &str = "2026.10.5";

const RELEASE_BASE: &str = "https://github.com/cloudflare/cloudflared/releases/download/2026.10.5";
const VERSION_KEY: &str = "cloudflared";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactKind {
    Archive,
    Raw,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Artifact {
    filename: &'static str,
    /// Digest of the DOWNLOADED asset (the `.tgz` itself for macOS), because
    /// that is what the download verifies. Pinning the digest of the extracted
    /// macOS binary instead makes every macOS install fail its checksum.
    sha256: &'static str,
    platform: &'static str,
    kind: ArtifactKind,
}

/// Core-managed Cloudflared executable path.
pub(crate) fn managed_path() -> PathBuf {
    bin_dir().join(if cfg!(target_os = "windows") {
        "cloudflared.exe"
    } else {
        "cloudflared"
    })
}

fn host_artifact(os: &str, arch: &str) -> Option<Artifact> {
    let (filename, sha256, platform, kind) = match (os, arch) {
        ("windows", "x86_64") => (
            "cloudflared-windows-amd64.exe",
            "db4e4c413612a0916f3e1679d3caaf376f94911952d163028fb726fb2e0516a9",
            "windows-amd64",
            ArtifactKind::Raw,
        ),
        ("windows", "x86") => (
            "cloudflared-windows-386.exe",
            "66cba8003e4f87a8e6b772f331b8c04c7d41ac4f2dc30dd2c13ae09de3b6007e",
            "windows-386",
            ArtifactKind::Raw,
        ),
        ("linux", "x86_64") => (
            "cloudflared-linux-amd64",
            "e1bc0cf084fd9e590554fe769a86b1db46701c3f847a43d902f7b974a4e16298",
            "linux-amd64",
            ArtifactKind::Raw,
        ),
        ("linux", "aarch64") => (
            "cloudflared-linux-arm64",
            "72e0d05a67e09da87cf495e409a28c3cc5994dd23fc66a982eebea6a55923b7d",
            "linux-arm64",
            ArtifactKind::Raw,
        ),
        ("linux", "arm") => (
            "cloudflared-linux-arm",
            "a018911e1bbfd739937f3011f589e9e73245baeee14742f8b3413472bb007adc",
            "linux-arm",
            ArtifactKind::Raw,
        ),
        ("linux", "x86") => (
            "cloudflared-linux-386",
            "f2de713829081837130b38e27f3c95aa9d7fc1a4f48b833362d21234dd8780d8",
            "linux-386",
            ArtifactKind::Raw,
        ),
        ("macos", "x86_64") => (
            "cloudflared-darwin-amd64.tgz",
            "6699392fed92367808c248c2d90bed66e49bbf66e1b4ee3e4141230f3f7391b3",
            "darwin-amd64",
            ArtifactKind::Archive,
        ),
        ("macos", "aarch64") => (
            "cloudflared-darwin-arm64.tgz",
            "184c7d4f5f977348243a6d7ca8f6cf6073b9b2746cfe8c1fe15aa59e9a522bf0",
            "darwin-arm64",
            ArtifactKind::Archive,
        ),
        _ => return None,
    };
    Some(Artifact {
        filename,
        sha256,
        platform,
        kind,
    })
}

pub(crate) fn can_install() -> bool {
    host_artifact(std::env::consts::OS, std::env::consts::ARCH).is_some()
}

pub(crate) struct CloudflaredDownloader;

impl CloudflaredDownloader {
    pub(crate) fn new() -> Self {
        Self
    }

    pub(crate) async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        let artifact = host_artifact(std::env::consts::OS, std::env::consts::ARCH)
            .context("Cloudflared Quick Tunnels are not managed on this platform")?;
        let destination = managed_path();
        let store = VersionStore::load();
        // The recorded checksum is the INSTALLED binary's, so it alone always
        // matches; without the version check a bumped target never upgrades.
        let recorded_version_is_target = store
            .versions
            .get(VERSION_KEY)
            .is_some_and(|version| version == CLOUDFLARED_TARGET_VERSION);
        if destination.is_file() && recorded_version_is_target {
            if let Some(recorded) = store.installed_checksum(VERSION_KEY) {
                if compute_sha256(&destination).await? == recorded {
                    return Ok(CLOUDFLARED_TARGET_VERSION.to_owned());
                }
                tracing::warn!("Cloudflared managed binary checksum mismatch; reinstalling");
            }
        }

        let url = format!("{RELEASE_BASE}/{}", artifact.filename);
        let temporary = crate::sidecar::download_manager::tmp_dir().join(format!(
            "cloudflared-{CLOUDFLARED_TARGET_VERSION}-{}.download",
            artifact.platform
        ));
        let downloaded = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Tool,
                role: crate::downloads::DownloadRole::Tool,
                label: "Cloudflared".to_owned(),
                url: url.clone(),
                dest: temporary,
                sha256: Some(artifact.sha256.to_owned()),
                version_record: None,
            })
            .await
            .with_context(|| format!("downloading Cloudflared from {url}"))?;

        let installed = match artifact.kind {
            ArtifactKind::Raw => {
                install_raw_binary(&downloaded, &destination).await?;
                destination
            }
            ArtifactKind::Archive => {
                let archive = tokio::fs::read(&downloaded)
                    .await
                    .context("reading the downloaded Cloudflared archive")?;
                let output_dir = bin_dir();
                let name = if cfg!(target_os = "windows") {
                    "cloudflared.exe"
                } else {
                    "cloudflared"
                };
                let path = tokio::task::spawn_blocking(move || {
                    extract_binary_with_libs(&archive, name, &output_dir, false)
                })
                .await
                .context("extracting the Cloudflared archive")??;
                mark_executable(&path)?;
                let _ = tokio::fs::remove_file(downloaded).await;
                path
            }
        };

        let installed_checksum = compute_sha256(&installed).await?;
        VersionStore::record_persisted(
            VERSION_KEY,
            CLOUDFLARED_TARGET_VERSION,
            &installed_checksum,
        )
        .context("writing Cloudflared's installed version")?;
        tracing::info!(path = %installed.display(), "Cloudflared installed");
        Ok(CLOUDFLARED_TARGET_VERSION.to_owned())
    }
}

async fn install_raw_binary(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let staged = destination.with_extension("download-tmp");
    tokio::fs::copy(source, &staged)
        .await
        .with_context(|| format!("staging Cloudflared at {}", staged.display()))?;
    mark_executable(&staged)?;
    #[cfg(target_os = "windows")]
    if destination.exists() {
        tokio::fs::remove_file(destination)
            .await
            .with_context(|| format!("replacing Cloudflared at {}", destination.display()))?;
    }
    tokio::fs::rename(&staged, destination)
        .await
        .with_context(|| format!("installing Cloudflared at {}", destination.display()))?;
    let _ = tokio::fs::remove_file(source).await;
    Ok(())
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

pub(crate) async fn install_cloudflared(
    downloads: &crate::downloads::DownloadCenter,
) -> Result<String> {
    CloudflaredDownloader::new()
        .ensure_installed(downloads)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_assets_are_pinned_and_checksum_verified_per_platform() {
        let windows = host_artifact("windows", "x86_64").expect("Windows amd64 asset");
        assert_eq!(windows.filename, "cloudflared-windows-amd64.exe");
        assert_eq!(windows.sha256.len(), 64);
        assert_eq!(windows.kind, ArtifactKind::Raw);

        let linux = host_artifact("linux", "aarch64").expect("Linux arm64 asset");
        assert_eq!(linux.filename, "cloudflared-linux-arm64");
        assert_eq!(linux.sha256.len(), 64);

        let mac = host_artifact("macos", "aarch64").expect("macOS arm64 asset");
        assert_eq!(mac.filename, "cloudflared-darwin-arm64.tgz");
        assert_eq!(mac.kind, ArtifactKind::Archive);
    }

    #[test]
    fn macos_digests_are_of_the_downloaded_archive_not_the_extracted_binary() {
        // The download verifies the `.tgz`. These are the digests of the
        // 2026.10.5 archives; the digests of the binaries inside them
        // (2b239645… arm64, cb09afb9… amd64) must never be pinned here.
        for (arch, archive, binary) in [
            (
                "aarch64",
                "184c7d4f5f977348243a6d7ca8f6cf6073b9b2746cfe8c1fe15aa59e9a522bf0",
                "2b23964528ddcd641c1449275df8b5b51e3c7193b5257919846331bc5bc13b0f",
            ),
            (
                "x86_64",
                "6699392fed92367808c248c2d90bed66e49bbf66e1b4ee3e4141230f3f7391b3",
                "cb09afb9b4d0a4730de477ac710aebb6107568930a8345775629bf264f70c284",
            ),
        ] {
            let artifact = host_artifact("macos", arch).expect("macOS asset");
            assert_eq!(artifact.kind, ArtifactKind::Archive);
            assert_eq!(artifact.sha256, archive, "{arch}");
            assert_ne!(artifact.sha256, binary, "{arch}");
        }
    }

    #[test]
    fn unsupported_platforms_do_not_offer_a_managed_install() {
        assert!(host_artifact("windows", "aarch64").is_none());
        assert!(host_artifact("freebsd", "x86_64").is_none());
    }
}
