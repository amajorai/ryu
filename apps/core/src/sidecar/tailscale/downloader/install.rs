//! The download legs behind [`TailscaleDownloader`]: the pinned upstream archive,
//! the Ryu release-owned userspace binaries, and the shared install entry point.

use std::path::PathBuf;

use anyhow::{Context, Result};

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
use super::exe_name;
use super::{
    archive_url, artifact_name, goarch, is_brew_leg, managed_pair_present, managed_path,
    ryu_asset_url, ryu_asset_url_in, ryu_platform, ryu_release_bases, url_override, CLI_BIN,
    DAEMON_BIN, RELEASE_URL_ENV, TAILSCALE_TARGET_VERSION,
};
use crate::sidecar::download_manager::{
    bin_dir, build_http_client, extract_binary_with_libs, fetch_sibling_sha256, sha256_sibling_url,
    VersionStore,
};

/// Downloads (or brews) the official Tailscale client into the profile's bin dir.
pub struct TailscaleDownloader {
    client: reqwest::Client,
}

impl Default for TailscaleDownloader {
    fn default() -> Self {
        Self::new()
    }
}

impl TailscaleDownloader {
    pub fn new() -> Self {
        Self {
            client: build_http_client(),
        }
    }

    /// Ensure a usable `tailscaled` + `tailscale` pair exists on this node,
    /// returning the version string recorded in `versions.json`.
    ///
    /// Routes by asset reality, not by uniformity: the override (any platform) and
    /// Linux take the pinned upstream archive leg; clean macOS/Windows hosts take
    /// the Ryu release-owned userspace binaries; macOS Homebrew remains a fallback
    /// for an older release that has no Ryu mesh assets yet.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        if url_override().is_some() {
            return self.install_from_archive(downloads).await;
        }
        #[cfg(target_os = "linux")]
        {
            return self.install_from_archive(downloads).await;
        }
        #[cfg(target_os = "macos")]
        {
            if ryu_platform().is_some() {
                match self.install_from_ryu_release(downloads).await {
                    Ok(version) => return Ok(version),
                    Err(error) if super::super::binary_resolves("brew") => {
                        tracing::warn!(
                            "Ryu mesh client asset unavailable; falling back to Homebrew: {error:#}"
                        );
                        return super::ensure_installed_via_brew().await;
                    }
                    Err(error) => return Err(error),
                }
            }
            let _ = downloads;
            return super::ensure_installed_via_brew().await;
        }
        #[cfg(target_os = "windows")]
        {
            return self.install_from_ryu_release(downloads).await;
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            let _ = downloads;
            anyhow::bail!(
                "Ryu cannot install the Tailscale client automatically on {}. Upstream \
                 publishes only an MSI/EXE installer here, and running it would register a \
                 root-privileged system service that collides with Ryu's userspace daemon. \
                 Install the official client from https://tailscale.com/download, or set \
                 {RELEASE_URL_ENV} to an archive containing `{}` and `{}`.",
                std::env::consts::OS,
                exe_name(DAEMON_BIN),
                exe_name(CLI_BIN),
            );
        }
    }

    /// The pinned-archive leg: download `tailscale_<ver>_<goarch>.tgz`, verify it
    /// against its sibling `.sha256`, and extract BOTH binaries into the profile's
    /// bin dir.
    async fn install_from_archive(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        let (url, is_override) = archive_url()?;
        // An override may point at any build, so claiming the pin for it would be a
        // lie the catalog would later repeat. Record a sentinel instead — and use
        // the SAME string in the fast path, so an override install is not
        // re-downloaded on every mesh enable.
        let record_version = if is_override {
            "unknown"
        } else {
            TAILSCALE_TARGET_VERSION
        };

        // Fast path: the recorded version matches AND both binaries are actually on
        // disk. Presence is checked as well as the record because `uninstall`
        // removes the binaries, and a stale row would otherwise claim an install
        // that is gone.
        let recorded = VersionStore::load().versions.get("tailscale").cloned();
        if recorded.as_deref() == Some(record_version) && managed_pair_present() {
            tracing::info!("tailscale {record_version} already installed — skipping");
            return Ok(record_version.to_owned());
        }

        // Integrity. `pkgs.tailscale.com` publishes a `.sha256` next to EVERY asset
        // (verified on every asset probed, including old pins), so a missing digest
        // there means something is wrong and we FAIL CLOSED — this artifact is a
        // network daemon Ryu then executes, and enabling the mesh neutralizes
        // loopback-admin trust gates elsewhere in Core.
        //
        // The override leg warns and continues instead, the same asymmetry ghost's
        // downloader documents: `RYU_TAILSCALE_RELEASE_URL`'s whole purpose is a
        // self-built or pre-release archive that has no sibling digest, so failing
        // closed there would make the documented knob unusable. The warning says
        // "unverified" in as many words; it must never read as though verification
        // happened. (`fetch_sibling_sha256` is https-only, so a plaintext override
        // lands here too — a digest fetched over http next to an http archive is
        // verification theatre.)
        let sha256 = fetch_sibling_sha256(&self.client, &url).await;
        if sha256.is_none() {
            if is_override {
                tracing::warn!(
                    "tailscale: no usable .sha256 at {} — downloading UNVERIFIED because \
                     {RELEASE_URL_ENV} is set",
                    sha256_sibling_url(&url)
                );
            } else {
                anyhow::bail!(
                    "tailscale: no usable checksum at {}. Upstream publishes one next to \
                     every asset, so refusing rather than executing unverified bytes for a \
                     network daemon. Retry, or set {RELEASE_URL_ENV} deliberately.",
                    sha256_sibling_url(&url)
                );
            }
        }

        tracing::info!("downloading the Tailscale client from {url}");
        // The temp name carries the version (or `override`) because `DownloadCenter`
        // resumes from a `<dest>.part`: a single shared filename would let a partial
        // pinned archive be resumed as an override's bytes, or vice versa, and the
        // result is a checksum mismatch nobody can explain.
        let is_zip = url.ends_with(".zip");
        let archive_ext = if is_zip { "zip" } else { "tgz" };
        let archive_dest = crate::sidecar::download_manager::tmp_dir().join(if is_override {
            format!("tailscale-override.{archive_ext}")
        } else {
            format!("tailscale-{TAILSCALE_TARGET_VERSION}.{archive_ext}")
        });
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Tool,
                role: crate::downloads::DownloadRole::Tool,
                label: "Tailscale".to_string(),
                url: url.clone(),
                dest: archive_dest,
                sha256,
                // Recorded below instead: the row must land only after BOTH
                // binaries are extracted and made executable, or a failed
                // extraction would leave `versions.json` claiming an install.
                version_record: None,
            })
            .await
            // Name the exact asset in the 404 case, in ghost's style — a bare
            // "HTTP 404" is a worse diagnosis than "this architecture has no
            // published build".
            .with_context(|| {
                format!(
                    "downloading the Tailscale archive from {url}. If this is a 404, upstream \
                     publishes no `{}` for this architecture ({}) — install the official \
                     client from https://tailscale.com/download, or set {RELEASE_URL_ENV} to \
                     an archive containing `{DAEMON_BIN}` and `{CLI_BIN}`.",
                    goarch().map_or_else(|| "tailscale_<ver>_<arch>.tgz".to_owned(), artifact_name),
                    std::env::consts::ARCH,
                )
            })?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading the downloaded Tailscale archive")?;

        // ONE `spawn_blocking` for both binaries: the archive is ~38 MB and two
        // calls would each need an owned copy and would gunzip the whole stream a
        // second time. `extract_binary_with_libs` flattens the archive's
        // `tailscale_<ver>_<arch>/` prefix, and its filters skip everything else
        // (the `systemd/` units are neither the wanted binary nor a shared lib).
        // The two names cannot cross-match: `is_wanted_binary` is exact-match plus
        // `.exe`, so `tailscaled` never satisfies `tailscale` or vice versa.
        let extract_dir = bin_dir();
        let extracted = tokio::task::spawn_blocking(move || -> Result<(PathBuf, PathBuf)> {
            let daemon = extract_binary_with_libs(&archive_data, DAEMON_BIN, &extract_dir, is_zip)?;
            let cli = extract_binary_with_libs(&archive_data, CLI_BIN, &extract_dir, is_zip)?;
            Ok((daemon, cli))
        })
        .await
        .context("spawn_blocking for Tailscale archive extraction")??;

        // MANDATORY, not hygiene: `extract_binary_with_libs` writes through
        // `std::fs::write`, which leaves default (non-executable) permissions. Skip
        // this and the only symptom is a "Permission denied" at spawn time, far
        // from here.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&extracted.0, &extracted.1] {
                let mut perms = std::fs::metadata(path)
                    .with_context(|| format!("stat {}", path.display()))?
                    .permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(path, perms)
                    .with_context(|| format!("chmod 0755 {}", path.display()))?;
            }
        }

        VersionStore::set_version_persisted("tailscale", record_version)
            .context("writing versions.json")?;

        // The binaries are in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        // DELIBERATELY no `PathManager::add_to_path()`, unlike every other
        // downloader here. The mesh reaches its binaries by ABSOLUTE path
        // (`resolve_mesh_pair`), so appending `~/.ryu/bin` to the user's shell
        // profile buys nothing locally — and doing it for an infra daemon is a
        // global, persistent edit to a file the user owns. It would also put a
        // second `tailscale` on their interactive PATH, shadowing whichever client
        // they meant to use. Do not "fix" this back.
        tracing::info!(
            daemon = %extracted.0.display(),
            cli = %extracted.1.display(),
            "tailscale client installed"
        );
        Ok(record_version.to_owned())
    }

    /// Download the two direct, userspace binaries Ryu publishes for clean
    /// macOS/Windows hosts. The release workflow emits a sibling checksum for
    /// each binary, so this path is verified before either file is used.
    async fn install_from_ryu_release(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        let platform = ryu_platform().ok_or_else(|| {
            anyhow::anyhow!(
                "Ryu publishes no managed Tailscale userspace binaries for {}/{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            )
        })?;

        for binary in [DAEMON_BIN, CLI_BIN] {
            // The first base that publishes this asset's checksum is the one
            // that publishes the asset.
            let mut resolved = None;
            for base in ryu_release_bases() {
                let url = ryu_asset_url_in(&base, binary, platform);
                if let Some(checksum) = fetch_sibling_sha256(&self.client, &url).await {
                    resolved = Some((url, checksum));
                    break;
                }
            }
            let (url, checksum) = resolved.ok_or_else(|| {
                anyhow::anyhow!(
                    "no usable checksum published for the Ryu Tailscale asset at {}",
                    sha256_sibling_url(&ryu_asset_url(binary, platform))
                )
            })?;
            let temporary = crate::sidecar::download_manager::tmp_dir().join(format!(
                "tailscale-{TAILSCALE_TARGET_VERSION}-{platform}-{binary}.download"
            ));
            let downloaded = downloads
                .download_blocking(crate::downloads::DownloadSpec {
                    kind: crate::downloads::DownloadKind::Tool,
                    role: crate::downloads::DownloadRole::Tool,
                    label: "Tailscale".to_owned(),
                    url,
                    dest: temporary,
                    sha256: Some(checksum),
                    version_record: None,
                })
                .await
                .with_context(|| format!("downloading the managed Tailscale {binary} binary"))?;
            install_raw_binary(&downloaded, &managed_path(binary)).await?;
        }

        VersionStore::set_version_persisted("tailscale", TAILSCALE_TARGET_VERSION)
            .context("writing the managed Tailscale version")?;
        Ok(TAILSCALE_TARGET_VERSION.to_owned())
    }
}

async fn install_raw_binary(source: &std::path::Path, destination: &std::path::Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let staged = destination.with_extension("download-tmp");
    tokio::fs::copy(source, &staged)
        .await
        .with_context(|| format!("staging {}", destination.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&staged)?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&staged, permissions)?;
    }
    #[cfg(target_os = "windows")]
    if destination.exists() {
        tokio::fs::remove_file(destination)
            .await
            .with_context(|| format!("replacing {}", destination.display()))?;
    }
    tokio::fs::rename(&staged, destination)
        .await
        .with_context(|| format!("installing {}", destination.display()))?;
    let _ = tokio::fs::remove_file(source).await;
    Ok(())
}

/// Install the mesh client through the download overlay, picking the progress
/// shape the active leg can actually honour.
///
/// THE one install entry point. Three callers need identical behaviour and used
/// to have none: `POST /api/setup/tailscale/install` (the explicit button),
/// `POST /api/mesh/config` (turning the mesh ON now installs, rather than
/// reporting a missing client), and Core's boot self-heal for a node whose mesh
/// pref is already on. Keeping the leg choice here means a new leg is added once.
///
/// The brew leg emits no byte counts, so it registers as an INDETERMINATE task
/// (like `apfel`); release assets stream real bytes through `DownloadCenter`.
pub async fn install_mesh_client(downloads: &crate::downloads::DownloadCenter) -> Result<String> {
    let dl = TailscaleDownloader::new();
    if is_brew_leg() {
        downloads
            .register_indeterminate(
                "tool:tailscale".to_string(),
                crate::downloads::DownloadKind::Tool,
                "Tailscale".to_string(),
                dl.ensure_installed(downloads),
            )
            .await
    } else {
        dl.ensure_installed(downloads).await
    }
}

#[cfg(test)]
mod install_tests {
    use super::install_raw_binary;

    #[tokio::test]
    async fn raw_binary_install_replaces_the_destination_and_consumes_the_source() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("downloaded");
        let destination = dir.path().join("bin").join("tailscaled");
        tokio::fs::write(&source, b"new-binary")
            .await
            .expect("write source");
        tokio::fs::create_dir_all(destination.parent().unwrap())
            .await
            .expect("bin dir");
        tokio::fs::write(&destination, b"old-binary")
            .await
            .expect("write old");

        install_raw_binary(&source, &destination)
            .await
            .expect("install");

        assert_eq!(
            tokio::fs::read(&destination).await.expect("read"),
            b"new-binary"
        );
        assert!(
            !source.exists(),
            "the downloaded source is removed after install"
        );
        assert!(
            !destination.with_extension("download-tmp").exists(),
            "no staging file is left behind"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&destination)
                .expect("meta")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755, "the installed binary is executable");
        }
    }

    #[tokio::test]
    async fn raw_binary_install_creates_the_destination_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("downloaded");
        let destination = dir.path().join("nested").join("profile").join("tailscale");
        tokio::fs::write(&source, b"cli")
            .await
            .expect("write source");

        install_raw_binary(&source, &destination)
            .await
            .expect("install");

        assert_eq!(tokio::fs::read(&destination).await.expect("read"), b"cli");
    }
}
