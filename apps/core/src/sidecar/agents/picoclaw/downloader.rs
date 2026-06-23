//! PicoClaw downloader — fetches the latest release from sipeed/picoclaw on GitHub.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, compute_sha256, extract_from_tar_gz, extract_from_zip, retry_download,
    ryu_dir, ProgressCallback, VersionStore,
};

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "picoclaw.exe"
    } else {
        "picoclaw"
    };
    ryu_dir().join("bin").join(name)
}

pub fn binary_path() -> PathBuf {
    bin_path()
}

fn asset_name() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "picoclaw_Windows_x86_64.zip";

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "picoclaw_Windows_arm64.zip";

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "picoclaw_Darwin_arm64.tar.gz";

    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    return "picoclaw_Darwin_x86_64.tar.gz";

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "picoclaw_Linux_x86_64.tar.gz";

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "picoclaw_Linux_arm64.tar.gz";

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return "picoclaw_Linux_x86_64.tar.gz";
}

pub struct PicoClawDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl PicoClawDownloader {
    pub fn new() -> Self {
        Self {
            client: build_http_client(),
            on_progress: None,
        }
    }

    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        let dest = bin_path();

        let store = VersionStore::load();
        if dest.exists() {
            if let Some(stored) = store.installed_checksum("picoclaw") {
                let actual = compute_sha256(&dest).await?;
                if actual == stored {
                    tracing::info!("picoclaw already installed and checksum valid — skipping");
                    return Ok(());
                }
            }
        }

        let release: serde_json::Value = retry_download("picoclaw", 3, || {
            let client = self.client.clone();
            async move {
                client
                    .get("https://api.github.com/repos/sipeed/picoclaw/releases/latest")
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
        .context("fetching PicoClaw latest release")?;

        let tag = release["tag_name"]
            .as_str()
            .context("missing tag_name")?
            .to_string();

        let asset = asset_name();
        let url = format!("https://github.com/sipeed/picoclaw/releases/download/{tag}/{asset}");
        tracing::info!("downloading picoclaw {tag} from {url}");

        let archive_dest = ryu_dir()
            .join("tmp")
            .join(format!("picoclaw-{tag}-{asset}"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Agent,
                label: "PicoClaw".to_string(),
                url,
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading PicoClaw archive")?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading PicoClaw archive")?;

        let binary_name = if cfg!(target_os = "windows") {
            "picoclaw.exe"
        } else {
            "picoclaw"
        };
        let extracted = tokio::task::spawn_blocking(move || {
            if asset.ends_with(".zip") {
                extract_from_zip(&archive_data, binary_name)
            } else {
                extract_from_tar_gz(&archive_data, binary_name)
            }
        })
        .await
        .context("spawn_blocking for archive extraction")??;

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

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms)?;
        }

        let checksum = {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&extracted);
            hex::encode(hasher.finalize())
        };
        VersionStore::record_persisted("picoclaw", &tag, &checksum)
            .context("writing versions.json")?;

        let _ = tokio::fs::remove_file(&archive_path).await;

        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
        }

        tracing::info!("picoclaw {tag} installed at {}", dest.display());
        Ok(())
    }
}

impl Default for PicoClawDownloader {
    fn default() -> Self {
        Self::new()
    }
}
