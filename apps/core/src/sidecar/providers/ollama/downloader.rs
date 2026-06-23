//! Ollama downloader — fetches the latest release from ollama/ollama on GitHub.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, compute_sha256, retry_download, ryu_dir, ProgressCallback, VersionStore,
};

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "ollama.exe"
    } else {
        "ollama"
    };
    ryu_dir().join("bin").join(name)
}

/// Returns (asset_filename, archive_format) for the current platform.
fn asset_info() -> (&'static str, &'static str) {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return ("ollama-windows-amd64.zip", "zip");

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return ("ollama-windows-arm64.zip", "zip");

    #[cfg(target_os = "macos")]
    return ("ollama-darwin.tgz", "tgz");

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return ("ollama-linux-amd64.tar.zst", "zst");

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return ("ollama-linux-arm64.tar.zst", "zst");

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return ("ollama-linux-amd64.tar.zst", "zst");
}

pub struct OllamaDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl OllamaDownloader {
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
            if let Some(stored) = store.installed_checksum("ollama") {
                let actual = compute_sha256(&dest).await?;
                if actual == stored {
                    tracing::info!("ollama already installed and checksum valid — skipping");
                    return Ok(());
                }
            }
        }

        let release: serde_json::Value = retry_download("ollama", 3, || {
            let client = self.client.clone();
            async move {
                client
                    .get("https://api.github.com/repos/ollama/ollama/releases/latest")
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
        .context("fetching Ollama latest release")?;

        let tag = release["tag_name"]
            .as_str()
            .context("missing tag_name")?
            .to_string();

        let (asset, fmt) = asset_info();
        let url = format!("https://github.com/ollama/ollama/releases/download/{tag}/{asset}");
        tracing::info!("downloading ollama {tag} from {url}");

        // Download the release archive through the global DownloadCenter (#456)
        // to a deterministic temp dest, then read it back to extract the binary.
        let archive_dest = ryu_dir().join("tmp").join(format!("ollama-{tag}-{asset}"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Engine,
                label: "Ollama".to_string(),
                url,
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading Ollama archive")?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded Ollama archive")?;

        let binary_name = if cfg!(target_os = "windows") {
            "ollama.exe"
        } else {
            "ollama"
        };
        let extracted = tokio::task::spawn_blocking(move || match fmt {
            "zip" => Self::extract_from_zip(&archive_data, binary_name),
            "tgz" => Self::extract_from_tar_gz(&archive_data, binary_name),
            "zst" => Self::extract_from_tar_zst(&archive_data, binary_name),
            other => anyhow::bail!("unknown archive format: {}", other),
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
        VersionStore::record_persisted("ollama", &tag, &checksum)
            .context("writing versions.json")?;

        // The extracted binary is in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        tracing::info!("ollama {tag} installed at {}", dest.display());
        Ok(())
    }

    // Ollama uses three archive formats, so extraction stays here.
    fn extract_from_zip(data: &[u8], binary_name: &str) -> Result<Vec<u8>> {
        use std::io::{Cursor, Read};
        use zip::ZipArchive;

        let reader = Cursor::new(data);
        let mut archive = ZipArchive::new(reader).context("reading zip archive")?;

        for i in 0..archive.len() {
            let mut file = archive.by_index(i).context("reading zip entry")?;
            let name = file.name().to_string();
            if name.ends_with(binary_name) {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)
                    .context("reading zip entry bytes")?;
                return Ok(bytes);
            }
        }

        anyhow::bail!("binary '{}' not found in Ollama zip archive", binary_name)
    }

    fn extract_from_tar_gz(data: &[u8], binary_name: &str) -> Result<Vec<u8>> {
        use flate2::read::GzDecoder;
        use std::io::Read;
        use tar::Archive;

        let gz = GzDecoder::new(data);
        let mut archive = Archive::new(gz);

        for entry in archive.entries().context("reading tar entries")? {
            let mut entry = entry.context("reading tar entry")?;
            let path = entry.path().context("getting entry path")?;
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if file_name == binary_name {
                let mut bytes = Vec::new();
                entry
                    .read_to_end(&mut bytes)
                    .context("reading entry bytes")?;
                return Ok(bytes);
            }
        }

        anyhow::bail!("binary '{}' not found in Ollama tgz archive", binary_name)
    }

    fn extract_from_tar_zst(data: &[u8], binary_name: &str) -> Result<Vec<u8>> {
        use std::io::{Cursor, Read};
        use tar::Archive;

        let decoder = zstd::Decoder::new(Cursor::new(data)).context("creating zstd decoder")?;
        let mut archive = Archive::new(decoder);

        for entry in archive.entries().context("reading tar entries")? {
            let mut entry = entry.context("reading tar entry")?;
            let path = entry.path().context("getting entry path")?;
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if file_name == binary_name {
                let mut bytes = Vec::new();
                entry
                    .read_to_end(&mut bytes)
                    .context("reading entry bytes")?;
                return Ok(bytes);
            }
        }

        anyhow::bail!(
            "binary '{}' not found in Ollama tar.zst archive",
            binary_name
        )
    }
}

impl Default for OllamaDownloader {
    fn default() -> Self {
        Self::new()
    }
}
