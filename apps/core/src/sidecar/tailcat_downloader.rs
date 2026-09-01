//! Managed Tailcat binary installation.
//!
//! Tailcat is an adopted CLI at runtime, but a normal Ryu release should make
//! the CLI available without asking the user to install Go, Homebrew, or a
//! package manager. Linux and Windows use the pinned upstream release assets.
//! macOS is built by Ryu's release workflow because the upstream release does
//! not publish a macOS binary yet; the macOS assets live beside Ryu's release
//! binaries and carry sibling `.sha256` files.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    bin_dir, build_http_client, compute_sha256, extract_binary_with_libs, fetch_sibling_sha256,
    ryu_dir, VersionStore,
};

/// Tailcat release consumed by this Ryu build.
///
/// The CLI and wire format are not covered by an upstream stability promise,
/// so the version is pinned rather than resolved from `latest` at runtime.
pub const TAILCAT_TARGET_VERSION: &str = "0.3.0";

const UPSTREAM_RELEASE_BASE: &str = "https://github.com/tailscale/tailcat/releases/download/v0.3.0";
const DEFAULT_RYU_RELEASE_BASE: &str = "https://github.com/amajorai/ryu/releases/latest/download";
const RELEASE_URL_ENV: &str = "RYU_TAILCAT_RELEASE_URL";
const RELEASE_BASE_ENV: &str = "RYU_TAILCAT_RELEASE_BASE";
const VERSION_KEY: &str = "tailcat";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactKind {
    Archive { is_zip: bool },
    Raw,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Artifact {
    url: String,
    checksum: Option<String>,
    kind: ArtifactKind,
    platform: &'static str,
}

/// Path for the Core-managed Tailcat executable.
pub(crate) fn managed_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "tailcat.exe"
    } else {
        "tailcat"
    };
    bin_dir().join(name)
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn upstream_artifact(
    os: &str,
    rust_arch: &str,
) -> Option<(&'static str, &'static str, &'static str)> {
    match (os, rust_arch) {
        ("linux", "x86_64") => Some((
            "amd64",
            "42ee6acb92ac0a6d778bf803aab1dc76fbc3f576c6489ca1be854efcb4641899",
            "linux-amd64",
        )),
        ("linux", "aarch64") => Some((
            "arm64",
            "b88d8ca36d0aff233987a2551237d63d51f4f7bf1b4f6542c7d721a7eebb4969",
            "linux-arm64",
        )),
        ("linux", "arm") => Some((
            "armv7",
            "b16e1386473f55c63d2e423df6f91a0151e64cee12df486ba072fe76170245d4",
            "linux-armv7",
        )),
        ("windows", "x86_64") => Some((
            "amd64",
            "fd385c3dacb22248d6eed6c57c1dbfb56f413b1f0577e4ea0fd2b95374d2c9a1",
            "windows-amd64",
        )),
        ("windows", "aarch64") => Some((
            "arm64",
            "194a39e45d8475a15684ec70dfb9745185b68610c98ee3b369a9bd996fe29165",
            "windows-arm64",
        )),
        _ => None,
    }
}

fn macos_platform(rust_arch: &str) -> Option<&'static str> {
    match rust_arch {
        "aarch64" => Some("macos-arm64"),
        "x86_64" => Some("macos-x86_64"),
        _ => None,
    }
}

fn release_base() -> String {
    env_value(RELEASE_BASE_ENV).unwrap_or_else(|| DEFAULT_RYU_RELEASE_BASE.to_owned())
}

fn artifact_for(os: &str, rust_arch: &str) -> Option<Artifact> {
    if let Some(url) = env_value(RELEASE_URL_ENV) {
        let kind = if url.ends_with(".zip") {
            ArtifactKind::Archive { is_zip: true }
        } else if url.ends_with(".tar.gz") || url.ends_with(".tgz") {
            ArtifactKind::Archive { is_zip: false }
        } else {
            ArtifactKind::Raw
        };
        return Some(Artifact {
            url,
            checksum: None,
            kind,
            platform: "custom",
        });
    }

    if let Some((upstream_arch, checksum, platform)) = upstream_artifact(os, rust_arch) {
        let extension = if os == "windows" { "zip" } else { "tar.gz" };
        return Some(Artifact {
            url: format!(
                "{UPSTREAM_RELEASE_BASE}/tailcat_{TAILCAT_TARGET_VERSION}_{os}_{upstream_arch}.{extension}"
            ),
            checksum: Some(checksum.to_owned()),
            kind: ArtifactKind::Archive {
                is_zip: os == "windows",
            },
            platform,
        });
    }

    if os != "macos" {
        return None;
    }
    let platform = macos_platform(rust_arch)?;
    Some(Artifact {
        url: format!(
            "{}/tailcat-{TAILCAT_TARGET_VERSION}-{platform}",
            release_base().trim_end_matches('/')
        ),
        checksum: None,
        kind: ArtifactKind::Raw,
        platform,
    })
}

fn host_artifact() -> Result<Artifact> {
    let artifact = artifact_for(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| {
        anyhow::anyhow!(
            "Ryu cannot install Tailcat automatically on {}/{}. Set {RELEASE_URL_ENV} to a \
             verified archive or use {} to provide a compatible binary.",
            std::env::consts::OS,
            std::env::consts::ARCH,
            crate::sidecar::tailcat::ENV_TAILCAT_BIN,
        )
    })?;
    if !artifact.url.starts_with("https://") {
        anyhow::bail!("Tailcat release URL must use HTTPS: {}", artifact.url);
    }
    Ok(artifact)
}

/// Whether this Core has a managed-install route for Tailcat.
pub(crate) fn can_install() -> bool {
    host_artifact().is_ok()
}

pub struct TailcatDownloader {
    client: reqwest::Client,
}

impl Default for TailcatDownloader {
    fn default() -> Self {
        Self::new()
    }
}

impl TailcatDownloader {
    pub fn new() -> Self {
        Self {
            client: build_http_client(),
        }
    }

    /// Ensure the managed Tailcat binary exists at the profile's `bin/` path.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        let artifact = host_artifact()?;
        let destination = managed_path();
        let store = VersionStore::load();

        // The checksum is recorded for the extracted/raw executable, not the
        // upstream archive. This keeps the fast path valid across both artifact
        // forms and detects a damaged managed binary before it is spawned.
        if destination.is_file() {
            if let Some(recorded) = store.installed_checksum(VERSION_KEY) {
                if compute_sha256(&destination).await? == recorded {
                    tracing::info!("Tailcat {TAILCAT_TARGET_VERSION} already installed — skipping");
                    return Ok(TAILCAT_TARGET_VERSION.to_owned());
                }
                tracing::warn!("Tailcat managed binary checksum mismatch — reinstalling");
            }
        }

        let checksum = match artifact.checksum.clone() {
            Some(checksum) => Some(checksum),
            None => fetch_sibling_sha256(&self.client, &artifact.url).await,
        };
        let checksum = checksum.ok_or_else(|| {
            anyhow::anyhow!(
                "Tailcat has no usable checksum at {}. Refusing to execute an unverified \
                 network binary.",
                if artifact.checksum.is_some() {
                    format!("{} (embedded release digest)", artifact.url)
                } else {
                    format!("{}.sha256", artifact.url)
                },
            )
        })?;

        let installed = match artifact.kind {
            ArtifactKind::Archive { is_zip } => {
                let extension = if is_zip { "zip" } else { "tar.gz" };
                let archive_destination = ryu_dir().join("tmp").join(format!(
                    "tailcat-{TAILCAT_TARGET_VERSION}-{}.{}",
                    artifact.platform, extension
                ));
                let archive_path = downloads
                    .download_blocking(crate::downloads::DownloadSpec {
                        kind: crate::downloads::DownloadKind::Tool,
                        role: crate::downloads::DownloadRole::Tool,
                        label: "Tailcat".to_owned(),
                        url: artifact.url.clone(),
                        dest: archive_destination,
                        sha256: Some(checksum),
                        version_record: None,
                    })
                    .await
                    .with_context(|| format!("downloading Tailcat from {}", artifact.url))?;
                let archive_data = tokio::fs::read(&archive_path)
                    .await
                    .context("reading the downloaded Tailcat archive")?;
                let binary_name = if cfg!(target_os = "windows") {
                    "tailcat.exe"
                } else {
                    "tailcat"
                };
                let destination_dir = bin_dir();
                let extracted = tokio::task::spawn_blocking(move || {
                    extract_binary_with_libs(&archive_data, binary_name, &destination_dir, is_zip)
                })
                .await
                .context("extracting Tailcat archive")??;
                mark_executable(&extracted)?;
                let _ = tokio::fs::remove_file(archive_path).await;
                extracted
            }
            ArtifactKind::Raw => {
                let temporary = ryu_dir().join("tmp").join(format!(
                    "tailcat-{TAILCAT_TARGET_VERSION}-{}.download",
                    artifact.platform
                ));
                let downloaded = downloads
                    .download_blocking(crate::downloads::DownloadSpec {
                        kind: crate::downloads::DownloadKind::Tool,
                        role: crate::downloads::DownloadRole::Tool,
                        label: "Tailcat".to_owned(),
                        url: artifact.url,
                        dest: temporary,
                        sha256: Some(checksum),
                        version_record: None,
                    })
                    .await
                    .context("downloading the managed Tailcat binary")?;
                install_raw_binary(&downloaded, &destination).await?;
                destination
            }
        };

        let installed_checksum = compute_sha256(&installed).await?;
        VersionStore::record_persisted(VERSION_KEY, TAILCAT_TARGET_VERSION, &installed_checksum)
            .context("writing Tailcat's installed version")?;
        tracing::info!(path = %installed.display(), "Tailcat installed");
        Ok(TAILCAT_TARGET_VERSION.to_owned())
    }
}

async fn install_raw_binary(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let staged = destination.with_extension("download-tmp");
    tokio::fs::copy(source, &staged)
        .await
        .with_context(|| format!("staging Tailcat at {}", staged.display()))?;
    mark_executable(&staged)?;
    #[cfg(target_os = "windows")]
    if destination.exists() {
        tokio::fs::remove_file(destination)
            .await
            .with_context(|| format!("replacing existing Tailcat at {}", destination.display()))?;
    }
    tokio::fs::rename(&staged, destination)
        .await
        .with_context(|| format!("installing Tailcat at {}", destination.display()))?;
    let _ = tokio::fs::remove_file(source).await;
    Ok(())
}

fn mark_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

/// Install the selected Tailcat binary through the shared download center.
pub async fn install_tailcat(downloads: &crate::downloads::DownloadCenter) -> Result<String> {
    TailcatDownloader::new().ensure_installed(downloads).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_linux_assets_are_pinned_and_checksum_verified() {
        let artifact = artifact_for("linux", "x86_64").expect("linux amd64 artifact");
        assert_eq!(artifact.platform, "linux-amd64");
        assert!(artifact.url.ends_with("tailcat_0.3.0_linux_amd64.tar.gz"));
        assert_eq!(
            artifact.checksum.as_deref(),
            Some("42ee6acb92ac0a6d778bf803aab1dc76fbc3f576c6489ca1be854efcb4641899")
        );
        assert_eq!(artifact.kind, ArtifactKind::Archive { is_zip: false });
    }

    #[test]
    fn upstream_windows_assets_use_zip_and_support_arm64() {
        let artifact = artifact_for("windows", "aarch64").expect("windows arm64 artifact");
        assert_eq!(artifact.platform, "windows-arm64");
        assert!(artifact.url.ends_with("tailcat_0.3.0_windows_arm64.zip"));
        assert!(matches!(
            artifact.kind,
            ArtifactKind::Archive { is_zip: true }
        ));
        assert!(artifact.checksum.is_some());
    }

    #[test]
    fn macos_uses_a_ryu_release_asset_with_a_sibling_digest() {
        let artifact = artifact_for("macos", "aarch64").expect("macOS arm64 artifact");
        assert_eq!(artifact.platform, "macos-arm64");
        assert!(artifact.url.ends_with("tailcat-0.3.0-macos-arm64"));
        assert_eq!(artifact.kind, ArtifactKind::Raw);
        assert!(artifact.checksum.is_none());
    }

    #[test]
    fn unsupported_platforms_do_not_offer_an_install_route() {
        assert!(artifact_for("freebsd", "x86_64").is_none());
        assert!(artifact_for("macos", "x86").is_none());
    }

    #[tokio::test]
    async fn raw_install_replaces_the_managed_file_and_removes_the_staging_copy() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("downloaded-tailcat");
        let destination = directory.path().join("bin").join("tailcat");
        tokio::fs::write(&source, b"tailcat-test-binary")
            .await
            .expect("write source");

        install_raw_binary(&source, &destination)
            .await
            .expect("install raw binary");

        assert_eq!(
            tokio::fs::read(&destination)
                .await
                .expect("read destination"),
            b"tailcat-test-binary"
        );
        assert!(
            !source.exists(),
            "the verified temporary download is removed"
        );
        assert!(
            !destination.with_extension("download-tmp").exists(),
            "the atomic staging file is removed"
        );
    }
}
