//! Reusable per-platform archive downloader for binary-only ACP agents.
//!
//! Generalizes IronClaw's downloader (`ironclaw/downloader.rs`) into a spec the
//! agents catalog can apply to ANY agent distributed as per-platform GitHub
//! release archives (goose, opencode, cursor, …). The shape is:
//!   1. resolve a release tag — pinned, or GitHub `releases/latest`,
//!   2. build the direct asset URL from a template + the host platform tag,
//!   3. download through the global [`DownloadCenter`] (#456) so it streams to
//!      disk and shows in the overlay,
//!   4. extract the named binary (`.tar.gz` on unix, `.zip` on Windows),
//!   5. write atomically to `~/.ryu/bin/<binary>` (chmod 0755 on unix),
//!   6. record the install in [`VersionStore`] and add `~/.ryu/bin` to PATH.
//!
//! IronClaw is refactored onto this (its `ensure_installed` now delegates here)
//! so the abstraction is proven by its first consumer.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, compute_sha256, extract_from_tar_gz, extract_from_zip, retry_download,
    ryu_dir, VersionStore,
};

/// The host platform target triple used in release asset names. Matches the
/// Rust target-triple convention every Rust release CI emits (goose, IronClaw,
/// opencode all follow it). `cfg!`-gated, so it returns one value per build; the
/// pure [`build_asset_url`] takes the platform as a parameter so it stays
/// unit-testable across every target.
pub fn archive_platform_tag() -> &'static str {
    #[cfg(target_os = "windows")]
    return "x86_64-pc-windows-msvc";

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "aarch64-apple-darwin";

    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    return "x86_64-apple-darwin";

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "aarch64-unknown-linux-gnu";

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "x86_64-unknown-linux-gnu";

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return "x86_64-unknown-linux-gnu";
}

/// The archive extension for the host OS (`zip` on Windows, `tar.gz` elsewhere).
/// Parameterized into [`build_asset_url`] for the same testability reason.
pub fn archive_ext_for(is_windows: bool) -> &'static str {
    if is_windows {
        "zip"
    } else {
        "tar.gz"
    }
}

/// Build the direct release-asset URL from a spec's templated asset name.
///
/// `asset_template` carries the placeholders `{tag}`, `{platform}`, and `{ext}`
/// (e.g. `"goose-{platform}.{ext}"` or `"ironclaw-{platform}.{ext}"`). Pure: it
/// takes every varying input as an argument so tests can assert the URL for any
/// platform/ext without a `cfg!` build matrix.
pub fn build_asset_url(
    repo: &str,
    asset_template: &str,
    tag: &str,
    platform: &str,
    ext: &str,
) -> String {
    let asset = asset_template
        .replace("{tag}", tag)
        .replace("{platform}", platform)
        .replace("{ext}", ext);
    format!("https://github.com/{repo}/releases/download/{tag}/{asset}")
}

/// Declarative description of a binary-only agent distributed as per-platform
/// GitHub release archives. Carried on the agent's registry entry so the install
/// handler can fetch the binary before flipping the installed flag.
#[derive(Debug, Clone)]
pub struct ArchiveAgentSpec {
    /// `VersionStore` key + checksum cache key (e.g. `"goose"`).
    pub id: &'static str,
    /// GitHub `owner/name` (e.g. `"block/goose"`).
    pub repo: &'static str,
    /// Asset name template with `{tag}`/`{platform}`/`{ext}` placeholders
    /// (e.g. `"goose-{platform}.{ext}"`).
    pub asset_template: &'static str,
    /// Binary basename inside the archive WITHOUT extension (e.g. `"goose"`).
    /// The `.exe` suffix is appended automatically on Windows.
    pub binary_name: &'static str,
    /// Pinned release tag, or `None` to resolve GitHub `releases/latest`.
    pub pinned_tag: Option<&'static str>,
    /// Human label for the DownloadCenter overlay (e.g. `"goose"`).
    pub label: &'static str,
}

impl ArchiveAgentSpec {
    /// The OS-correct binary file name (`<binary_name>` or `<binary_name>.exe`).
    fn binary_file_name(&self) -> String {
        if cfg!(target_os = "windows") {
            format!("{}.exe", self.binary_name)
        } else {
            self.binary_name.to_owned()
        }
    }

    /// Absolute path where the managed binary is installed (`~/.ryu/bin/<bin>`).
    pub fn binary_path(&self) -> PathBuf {
        ryu_dir().join("bin").join(self.binary_file_name())
    }
}

/// Ensure the agent's binary is installed at `~/.ryu/bin/<binary>`, downloading
/// and extracting the per-platform archive when absent or checksum-stale.
///
/// Near-verbatim lift of `ironclaw/downloader.rs::ensure_installed` with the
/// repo/asset/binary parameterized through [`ArchiveAgentSpec`].
pub async fn ensure_installed(
    spec: &ArchiveAgentSpec,
    downloads: &crate::downloads::DownloadCenter,
) -> Result<PathBuf> {
    let dest = spec.binary_path();

    // Fast path: already installed with a matching checksum.
    let store = VersionStore::load();
    if dest.exists() {
        if let Some(stored) = store.installed_checksum(spec.id) {
            let actual = compute_sha256(&dest).await?;
            if actual == stored {
                tracing::info!(
                    "{} already installed and checksum valid — skipping",
                    spec.id
                );
                return Ok(dest);
            }
            tracing::warn!(
                "{} checksum mismatch (stored={stored} actual={actual}), re-downloading",
                spec.id
            );
        }
    }

    // Resolve the release tag: pinned, or GitHub releases/latest.
    let tag = match spec.pinned_tag {
        Some(t) => t.to_owned(),
        None => {
            let client = build_http_client();
            let repo = spec.repo.to_owned();
            let id = spec.id;
            let release: serde_json::Value = retry_download(id, 3, || {
                let client = client.clone();
                let repo = repo.clone();
                async move {
                    client
                        .get(format!(
                            "https://api.github.com/repos/{repo}/releases/latest"
                        ))
                        .header("Accept", "application/vnd.github+json")
                        .send()
                        .await
                        .context("GET github releases/latest")?
                        .error_for_status()
                        .context("HTTP error fetching release")?
                        .json::<serde_json::Value>()
                        .await
                        .context("parsing release JSON")
                }
            })
            .await
            .with_context(|| format!("fetching {} latest release from GitHub", spec.id))?;

            release["tag_name"]
                .as_str()
                .context("missing tag_name in release response")?
                .to_string()
        }
    };

    // Construct the direct asset URL.
    let is_windows = cfg!(target_os = "windows");
    let platform = archive_platform_tag();
    let ext = archive_ext_for(is_windows);
    let url = build_asset_url(spec.repo, spec.asset_template, &tag, platform, ext);
    tracing::info!("downloading {} {tag} from {url}", spec.id);

    // Download the archive through the center to a deterministic temp dest
    // (so its own `.part`/resume works), then read it back to extract.
    let archive_dest = ryu_dir()
        .join("tmp")
        .join(format!("{}-{tag}.{ext}", spec.id));
    let archive_path = downloads
        .download_blocking(crate::downloads::DownloadSpec {
            kind: crate::downloads::DownloadKind::Agent,
            label: spec.label.to_string(),
            url,
            dest: archive_dest,
            sha256: None,
            version_record: None,
        })
        .await
        .with_context(|| format!("downloading {} archive", spec.id))?;
    let archive_data = tokio::fs::read(&archive_path)
        .await
        .with_context(|| format!("reading downloaded {} archive", spec.id))?;

    // Extract the binary from the archive (blocking I/O on the thread-pool).
    let binary_name = spec.binary_file_name();
    let extracted = tokio::task::spawn_blocking(move || {
        if is_windows {
            extract_from_zip(&archive_data, &binary_name)
        } else {
            extract_from_tar_gz(&archive_data, &binary_name)
        }
    })
    .await
    .context("spawn_blocking for archive extraction")??;

    // Write the extracted binary atomically.
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp_path = dest.with_extension("tmp");
    tokio::fs::write(&tmp_path, &extracted)
        .await
        .with_context(|| format!("writing {}", tmp_path.display()))?;
    tokio::fs::rename(&tmp_path, &dest)
        .await
        .with_context(|| format!("rename {} → {}", tmp_path.display(), dest.display()))?;

    // Make executable on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms)?;
    }

    // Compute the checksum from the in-memory bytes and persist.
    let checksum = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&extracted);
        hex::encode(hasher.finalize())
    };
    VersionStore::record_persisted(spec.id, &tag, &checksum).context("writing versions.json")?;

    // The extracted binary is in place; drop the temp archive.
    let _ = tokio::fs::remove_file(&archive_path).await;

    // Ensure PATH includes ~/.ryu/bin.
    if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
        tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
    }

    tracing::info!("{} {tag} installed at {}", spec.id, dest.display());
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_asset_url_substitutes_all_placeholders() {
        // goose convention: goose-<platform>.<ext>
        let url = build_asset_url(
            "block/goose",
            "goose-{platform}.{ext}",
            "v1.38.0",
            "aarch64-apple-darwin",
            "tar.gz",
        );
        assert_eq!(
            url,
            "https://github.com/block/goose/releases/download/v1.38.0/goose-aarch64-apple-darwin.tar.gz"
        );
    }

    #[test]
    fn build_asset_url_windows_zip() {
        let url = build_asset_url(
            "block/goose",
            "goose-{platform}.{ext}",
            "v1.38.0",
            "x86_64-pc-windows-msvc",
            "zip",
        );
        assert_eq!(
            url,
            "https://github.com/block/goose/releases/download/v1.38.0/goose-x86_64-pc-windows-msvc.zip"
        );
    }

    #[test]
    fn build_asset_url_matches_ironclaw_legacy_shape() {
        // The shape IronClaw's downloader hardcoded:
        // ironclaw-{platform}.{ext} under nearai/ironclaw.
        for platform in [
            "x86_64-pc-windows-msvc",
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "aarch64-unknown-linux-gnu",
            "x86_64-unknown-linux-gnu",
        ] {
            let ext = if platform.contains("windows") {
                "zip"
            } else {
                "tar.gz"
            };
            let url = build_asset_url(
                "nearai/ironclaw",
                "ironclaw-{platform}.{ext}",
                "v0.1.0",
                platform,
                ext,
            );
            assert_eq!(
                url,
                format!(
                    "https://github.com/nearai/ironclaw/releases/download/v0.1.0/ironclaw-{platform}.{ext}"
                )
            );
        }
    }

    #[test]
    fn archive_ext_picks_zip_for_windows() {
        assert_eq!(archive_ext_for(true), "zip");
        assert_eq!(archive_ext_for(false), "tar.gz");
    }

    #[test]
    fn platform_tag_is_a_known_target_triple() {
        // The host tag must be one of the asset triples we template against.
        let tag = archive_platform_tag();
        assert!(
            [
                "x86_64-pc-windows-msvc",
                "aarch64-apple-darwin",
                "x86_64-apple-darwin",
                "aarch64-unknown-linux-gnu",
                "x86_64-unknown-linux-gnu",
            ]
            .contains(&tag),
            "unexpected platform tag: {tag}"
        );
    }
}
