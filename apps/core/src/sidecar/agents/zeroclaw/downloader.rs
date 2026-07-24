//! ZeroClaw downloader — fetches the latest release tag from the GitHub API
//! and constructs the direct asset URL, with exponential-backoff retry logic.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, compute_sha256, extract_from_tar_gz, extract_from_zip, retry_download,
    ryu_dir, ProgressCallback, VersionStore,
};

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "zeroclaw.exe"
    } else {
        "zeroclaw"
    };
    ryu_dir().join("bin").join(name)
}

pub fn binary_path() -> PathBuf {
    bin_path()
}

fn zeroclaw_platform_tag() -> &'static str {
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

// ── ZeroClawDownloader ─────────────────────────────────────────────────────────

pub struct ZeroClawDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl ZeroClawDownloader {
    pub fn new() -> Self {
        Self {
            client: build_http_client(),
            on_progress: None,
        }
    }

    /// Ensure ZeroClaw binary is installed at `~/.ryu/bin/zeroclaw`.
    ///
    /// The release tag is still fetched via the GitHub API directly; only the
    /// asset archive download is routed through the global [`DownloadCenter`]
    /// (#456) so it streams to disk and shows in the overlay.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        let dest = bin_path();

        // Fast path: already installed with a matching checksum.
        let store = VersionStore::load();
        if dest.exists() {
            if let Some(stored) = store.installed_checksum("zeroclaw") {
                let actual = compute_sha256(&dest).await?;
                if actual == stored {
                    tracing::info!("zeroclaw already installed and checksum valid — skipping");
                    return Ok(());
                }
                tracing::warn!(
                    "zeroclaw checksum mismatch (stored={stored} actual={actual}), re-downloading"
                );
            }
        }

        // Fetch latest release tag from GitHub API.
        let release: serde_json::Value = retry_download("zeroclaw", 3, || {
            let client = self.client.clone();
            async move {
                client
                    .get("https://api.github.com/repos/zeroclaw-labs/zeroclaw/releases/latest")
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
        .context("fetching ZeroClaw latest release from GitHub")?;

        let tag = release["tag_name"]
            .as_str()
            .context("missing tag_name in release response")?
            .to_string();

        // Construct direct asset URL.
        let platform = zeroclaw_platform_tag();
        let ext = if cfg!(target_os = "windows") {
            "zip"
        } else {
            "tar.gz"
        };
        let url = format!(
            "https://github.com/zeroclaw-labs/zeroclaw/releases/download/{tag}/zeroclaw-{platform}.{ext}"
        );
        tracing::info!("downloading zeroclaw {tag} from {url}");

        // Download the asset archive through the center to a deterministic temp
        // dest (so its own `.part`/resume works), then read it back to extract.
        let archive_dest = ryu_dir().join("tmp").join(format!("zeroclaw-{tag}.{ext}"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Agent,
                label: "ZeroClaw".to_string(),
                url,
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading ZeroClaw archive")?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded ZeroClaw archive")?;

        // Extract binary from archive (blocking I/O on thread-pool).
        let binary_name = if cfg!(target_os = "windows") {
            "zeroclaw.exe"
        } else {
            "zeroclaw"
        };
        let extracted = tokio::task::spawn_blocking(move || {
            #[cfg(target_os = "windows")]
            {
                extract_from_zip(&archive_data, binary_name)
            }
            #[cfg(not(target_os = "windows"))]
            {
                extract_from_tar_gz(&archive_data, binary_name)
            }
        })
        .await
        .context("spawn_blocking for archive extraction")??;

        // Write extracted binary atomically.
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

        // Compute checksum from in-memory bytes and persist (avoids re-reading from disk).
        let checksum = {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&extracted);
            hex::encode(hasher.finalize())
        };
        VersionStore::record_persisted("zeroclaw", &tag, &checksum)
            .context("writing versions.json")?;

        // The extracted binary is in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        // Ensure PATH includes ~/.ryu/bin
        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
        }

        tracing::info!("zeroclaw {tag} installed at {}", dest.display());
        Ok(())
    }
}

impl Default for ZeroClawDownloader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn skips_when_checksum_matches() -> Result<()> {
        use sha2::Digest;

        let tmp_dir =
            std::env::temp_dir().join(format!("ryu-zeroclaw-test-{}", std::process::id()));
        tokio::fs::create_dir_all(&tmp_dir).await?;
        let bin = tmp_dir.join("zeroclaw");

        let content = b"fake-zeroclaw-binary";
        tokio::fs::write(&bin, content).await?;
        let checksum = hex::encode(sha2::Sha256::digest(content));

        let actual = compute_sha256(&bin).await?;
        assert_eq!(actual, checksum, "compute_sha256 should match manual hash");

        tokio::fs::remove_dir_all(&tmp_dir).await.ok();
        Ok(())
    }

    #[test]
    fn platform_tag_is_a_rust_triple_for_this_target() {
        let tag = zeroclaw_platform_tag();
        // Every branch resolves to a `<arch>-<vendor>-<os>` release triple.
        assert!(tag.split('-').count() >= 3, "unexpected tag: {tag}");
        if cfg!(target_os = "windows") {
            assert!(tag.contains("windows"));
        } else if cfg!(target_os = "macos") {
            assert!(tag.contains("apple-darwin"));
        } else {
            assert!(tag.contains("linux"));
        }
    }

    #[test]
    fn binary_path_is_under_ryu_bin() {
        let p = binary_path();
        assert_eq!(p, bin_path());
        assert!(p.ends_with(if cfg!(target_os = "windows") {
            "zeroclaw.exe"
        } else {
            "zeroclaw"
        }));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "bin");
    }
}
