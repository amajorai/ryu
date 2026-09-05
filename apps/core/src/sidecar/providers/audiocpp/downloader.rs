//! Reproducible audio.cpp binary and model installer.
//!
//! The release archive and the three default model files are pinned by URL and
//! SHA-256. Models are kept in capability-specific directories so a TTS-only
//! install can start without forcing the ASR model into memory, while the full
//! sidecar install provisions both paths.

use std::path::PathBuf;

use anyhow::{Context, Result};

use super::{binary_path, stt_model_path, tts_model_path, tts_voice_path};
use crate::sidecar::download_manager::{
    compute_sha256, extract_binary_with_libs, ryu_dir, VersionStore,
};

/// Ryu's pinned audio.cpp release. Update this together with the asset hashes
/// below and the catalog installer pin.
pub const TARGET_VERSION: &str = "v0.7.1";

const HF_REVISION: &str = "78f9d27aa214792b77256affe774eea57e35b9ae";
const STT_MODEL_FILE: &str = "parakeet-tdt-0.6b-v3-q8_0.gguf";
const TTS_MODEL_FILE: &str = "pocket-tts-english-q8_0.gguf";
const TTS_VOICE_FILE: &str = "alba.safetensors";

const STT_MODEL_SHA256: &str = "074e61ac1abd3d3efcfc10798d17bf9a975b31768b466fc2578364d206dde64c";
const TTS_MODEL_SHA256: &str = "0315406421d515d9ffbde49ed998832ff2962562ef8abde440c85fa0a27d8b2a";
const TTS_VOICE_SHA256: &str = "69c32db63ca56843d994f81f343f62e0bf2d73f7e4c9bc73e44bb1110b1d8845";

const HF_ROOT: &str = "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve";

fn model_url(path: &str) -> String {
    format!("{HF_ROOT}/{HF_REVISION}/{path}")
}

struct BinaryAsset {
    url: &'static str,
    sha256: &'static str,
    archive_is_zip: bool,
}

fn binary_asset() -> Result<BinaryAsset> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Ok(BinaryAsset {
        url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.7.1/audio-v0.7.1-bin-macos-arm64-metal.tar.gz",
        sha256: "b45b51e6006e4999167c28b3fa55e643ae34c2a19e9816639769759c4404e71c",
        archive_is_zip: false,
    });

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Ok(BinaryAsset {
        url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.7.1/audio-v0.7.1-bin-macos-x64-metal.tar.gz",
        sha256: "15b9292543889151450434f6455a57ff09597d80bdfa9b64685bd1d58e49d50e",
        archive_is_zip: false,
    });

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return Ok(BinaryAsset {
        url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.7.1/audio-v0.7.1-bin-ubuntu-x64-cpu.tar.gz",
        sha256: "257119ac1820765dc20f58a4d9438a4620669edf04678ceec60da8728234e95f",
        archive_is_zip: false,
    });

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Ok(BinaryAsset {
        url: "https://github.com/0xShug0/audio.cpp/releases/download/v0.7.1/audio-v0.7.1-bin-windows-x64-cpu.zip",
        sha256: "6042e9d00689575b3d9feb849ace77ae4b05c73ad3a6b344037a01c166333649",
        archive_is_zip: true,
    });

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    anyhow::bail!(
        "audio.cpp has no pinned prebuilt server for {}-{} (supported: macOS arm64/x64, Linux x86_64, Windows x86_64)",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
}

pub struct AudioCppDownloader;

impl AudioCppDownloader {
    pub fn new() -> Self {
        Self
    }

    /// Install the native server and both default capability models.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        self.ensure_binary(downloads).await?;
        self.ensure_stt_model(downloads).await?;
        self.ensure_tts_model(downloads).await?;
        Ok(TARGET_VERSION.to_string())
    }

    /// Install only the PocketTTS package. The TTS model catalog calls this
    /// operation; a later full sidecar install adds Parakeet without replacing
    /// the already-downloaded TTS files.
    pub async fn ensure_tts_model(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        self.ensure_tts_model_files(downloads).await?;
        Ok(TARGET_VERSION.to_string())
    }

    pub async fn ensure_stt_model(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<PathBuf> {
        if let Some(custom) = custom_existing_path("RYU_AUDIOCPP_STT_MODEL")? {
            return Ok(custom);
        }
        let url = model_url("Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf");
        ensure_file(
            downloads,
            "audiocpp-model:parakeet-tdt-0.6b-v3-q8_0",
            "audio.cpp Parakeet-TDT STT",
            &url,
            STT_MODEL_SHA256,
            stt_model_path(),
            STT_MODEL_FILE,
        )
        .await
    }

    async fn ensure_tts_model_files(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        if custom_existing_path("RYU_AUDIOCPP_TTS_MODEL")?.is_none() {
            let url = model_url("PocketTTS-GGUF/english/pocket-tts-english-q8_0.gguf");
            ensure_file(
                downloads,
                "audiocpp-model:pocket-tts-english-q8_0",
                "audio.cpp PocketTTS model",
                &url,
                TTS_MODEL_SHA256,
                tts_model_path(),
                TTS_MODEL_FILE,
            )
            .await?;
        }
        if custom_existing_path("RYU_AUDIOCPP_TTS_VOICE_FILE")?.is_none() {
            let url = model_url("PocketTTS-GGUF/english/embeddings/alba.safetensors");
            ensure_file(
                downloads,
                "audiocpp-voice:alba",
                "audio.cpp Alba voice",
                &url,
                TTS_VOICE_SHA256,
                tts_voice_path(),
                TTS_VOICE_FILE,
            )
            .await?;
        }
        Ok(())
    }

    async fn ensure_binary(&self, downloads: &crate::downloads::DownloadCenter) -> Result<()> {
        if let Some(custom) = custom_existing_path("RYU_AUDIOCPP_BIN")? {
            tracing::info!(path = %custom.display(), "using externally supplied audio.cpp binary");
            return Ok(());
        }

        let dest = binary_path();
        let store = VersionStore::load();
        if dest.exists()
            && store.versions.get("audiocpp").map(String::as_str) == Some(TARGET_VERSION)
        {
            tracing::info!("audiocpp_server {TARGET_VERSION} already installed — skipping");
            return Ok(());
        }

        let asset = binary_asset()?;
        let archive_dest = ryu_dir()
            .join("tmp")
            .join(format!("audiocpp-{TARGET_VERSION}.archive"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                role: crate::downloads::DownloadRole::Engine,
                label: "audio.cpp runtime".to_string(),
                url: asset.url.to_string(),
                dest: archive_dest,
                sha256: Some(asset.sha256.to_string()),
                version_record: None,
            })
            .await
            .context("downloading audio.cpp runtime archive")?;
        let archive = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded audio.cpp runtime archive")?;

        let destination = dest
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| ryu_dir().join("bin").join("audiocpp"));
        let staging = destination
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(format!(
                ".audiocpp-staging-{}",
                uuid::Uuid::new_v4().simple()
            ));
        tokio::fs::create_dir_all(&staging).await.with_context(|| {
            format!("creating audio.cpp staging directory {}", staging.display())
        })?;

        let binary_name = dest
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("audiocpp_server")
            .to_string();
        let staging_for_extract = staging.clone();
        let extracted = match tokio::task::spawn_blocking(move || {
            extract_binary_with_libs(
                &archive,
                &binary_name,
                &staging_for_extract,
                asset.archive_is_zip,
            )
        })
        .await
        .context("spawning audio.cpp archive extraction")?
        {
            Ok(path) => path,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err(error).context("extracting audio.cpp runtime");
            }
        };

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = tokio::fs::metadata(&extracted)
                .await
                .context("reading extracted audio.cpp permissions")?;
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o755);
            tokio::fs::set_permissions(&extracted, permissions)
                .await
                .context("marking audiocpp_server executable")?;
        }

        // Keep the active runtime intact until the new archive has been fully
        // downloaded, extracted, and permissioned. Rename the old directory to
        // a sibling backup, publish the staged directory, and restore the backup
        // if the publish rename fails. This avoids turning a failed update into a
        // missing runtime (the previous implementation deleted first).
        let backup = destination
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(format!(
                ".audiocpp-backup-{}",
                uuid::Uuid::new_v4().simple()
            ));
        let had_existing = destination.exists();
        if had_existing {
            tokio::fs::rename(&destination, &backup)
                .await
                .with_context(|| {
                    format!(
                        "staging existing audio.cpp runtime at {}",
                        destination.display()
                    )
                })?;
        }
        if let Err(error) = tokio::fs::rename(&staging, &destination).await {
            if had_existing {
                let _ = tokio::fs::rename(&backup, &destination).await;
            }
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(error).with_context(|| {
                format!("publishing audio.cpp runtime at {}", destination.display())
            });
        }
        if had_existing {
            tokio::fs::remove_dir_all(&backup).await.with_context(|| {
                format!("removing old audio.cpp runtime at {}", backup.display())
            })?;
        }

        VersionStore::set_version_persisted("audiocpp", TARGET_VERSION)
            .context("writing audio.cpp version marker")?;
        let _ = tokio::fs::remove_file(&archive_path).await;
        tracing::info!(
            version = TARGET_VERSION,
            path = %dest.display(),
            "audio.cpp runtime installed"
        );
        Ok(())
    }
}

impl Default for AudioCppDownloader {
    fn default() -> Self {
        Self::new()
    }
}

fn custom_existing_path(key: &str) -> Result<Option<PathBuf>> {
    let Some(value) = std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if path.exists() {
        Ok(Some(path))
    } else {
        anyhow::bail!("{key} points to a missing path: {}", path.display())
    }
}

async fn ensure_file(
    downloads: &crate::downloads::DownloadCenter,
    store_key: &str,
    label: &str,
    url: &str,
    sha256: &str,
    dest: PathBuf,
    version: &str,
) -> Result<PathBuf> {
    if dest.is_file() {
        let actual = compute_sha256(&dest)
            .await
            .with_context(|| format!("checking installed {label}"))?;
        if actual.eq_ignore_ascii_case(sha256) {
            // Repair an old/missing marker after verifying the bytes. The marker
            // is an optimization for the next boot, never the integrity proof.
            if VersionStore::load()
                .checksums
                .get(store_key)
                .is_none_or(|recorded| !recorded.eq_ignore_ascii_case(sha256))
            {
                VersionStore::record_persisted(store_key, version, sha256)
                    .with_context(|| format!("recording verified {label}"))?;
            }
            tracing::info!(path = %dest.display(), "{label} already installed and checksum valid — skipping");
            return Ok(dest);
        }
        tracing::warn!(
            path = %dest.display(),
            expected = sha256,
            actual,
            "{label} checksum mismatch — redownloading"
        );
    } else if dest.exists() {
        anyhow::bail!("installed {label} path is not a file: {}", dest.display());
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating model directory {}", parent.display()))?;
    }
    downloads
        .download_blocking(crate::downloads::DownloadSpec {
            kind: crate::downloads::DownloadKind::Voice,
            role: crate::downloads::DownloadRole::SpeechModel,
            label: label.to_string(),
            url: url.to_string(),
            dest: dest.clone(),
            sha256: Some(sha256.to_string()),
            version_record: Some(crate::downloads::VersionRecord {
                store_key: store_key.to_string(),
                version: version.to_string(),
            }),
        })
        .await
        .with_context(|| format!("downloading {label}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_release_asset_is_pinned_for_this_platform() {
        let asset = binary_asset().expect("the development platform has a pinned asset");
        assert!(asset.url.contains(TARGET_VERSION));
        assert_eq!(asset.sha256.len(), 64);
        assert_eq!(HF_REVISION.len(), 40);
    }

    #[test]
    fn model_urls_are_revision_pinned() {
        for url in [
            model_url("Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf"),
            model_url("PocketTTS-GGUF/english/pocket-tts-english-q8_0.gguf"),
            model_url("PocketTTS-GGUF/english/embeddings/alba.safetensors"),
        ] {
            assert!(url.contains(HF_REVISION));
            assert!(url.contains("resolve/"));
        }
    }
}
