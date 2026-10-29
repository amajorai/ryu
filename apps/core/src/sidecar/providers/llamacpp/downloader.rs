//! llama.cpp downloader. Pulls the platform release archive (`.zip` on Windows,
//! `.tar.gz` on macOS/Linux) and extracts the binary, plus GGUF weight download
//! for the bundled local chat model.
//!
//! **Which** archive is pulled is the [`variant`](super::variant) question: the
//! CPU build, or an accelerated one (Metal/CUDA/Vulkan), auto-detected from the
//! machine's GPU unless the user pinned a choice. One variant is installed at a
//! time, into its own directory, and switching wipes the previous one.

use std::path::PathBuf;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use super::variant::{self, LlamaVariant};
use crate::registry::{LocalModelEntry, ModelRegistry};
use crate::sidecar::download_manager::{
    build_http_client, extract_binary_with_libs_from, tmp_dir, ProgressCallback, VersionStore,
};

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_path() -> PathBuf {
    variant::server_path()
}

// b10218 includes llama.cpp's request-armed reasoning control, which lets Core
// ask a running local completion to leave its reasoning block early. It also
// retains the MTP speculative-decoding flags used by the inference controls.
// NOTE: b9xxx removed `--draft-max`/`--draft-min` in favour of
// `--spec-draft-n-max`/`--spec-draft-n-min` (see `inference::LaunchConfig`).
/// The release tag this build installs. Pinned at compile time: `archive_url()`
/// is derived from it, so this is the ONLY version `ensure_installed` can
/// deliver — upstream's newer tags are unreachable without a code change.
/// `catalog::registry::installer_pin` reads it so the catalog advertises the
/// deliverable version instead of GitHub's latest (which produced a permanent
/// "update available" row whose Update button could never do anything).
pub const TARGET_VERSION: &str = "b10218";

/// Serializes every write into the shared llama.cpp install directory: a
/// variant install wipes and re-extracts it, and `ensure_tts_binary` extracts
/// into it too, so either running beside another deletes files mid-extract.
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Release-archive URL for `variant` on this platform. Every variant resolves
/// through [`LlamaVariant::asset_slug`], so the URL and the "can this node run
/// it" gate can never disagree about which asset exists.
fn archive_url(variant: LlamaVariant) -> Result<String> {
    let tag = TARGET_VERSION;
    let platform = variant.asset_slug().ok_or_else(|| {
        anyhow::anyhow!(
            "llama.cpp publishes no {} build for {}-{}",
            variant.as_str(),
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let ext = archive_ext();
    Ok(format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{tag}/llama-{tag}-bin-{platform}.{ext}"
    ))
}

/// SHA-256 digests published by GitHub for the pinned `b10218` release assets.
///
/// Engine downloads are deliberately required to carry a checksum by the
/// shared DownloadCenter. Keeping the digest next to the compile-time release
/// pin makes the URL, platform gate, and verification requirement one contract;
/// an unknown future asset fails closed instead of silently downloading an
/// executable without verification. Values were read from the release asset
/// metadata at `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b10218`.
fn archive_sha256(variant: LlamaVariant) -> Result<&'static str> {
    let platform = variant.asset_slug().ok_or_else(|| {
        anyhow::anyhow!(
            "llama.cpp publishes no {} build for {}-{}",
            variant.as_str(),
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    archive_sha256_for_platform(platform).ok_or_else(|| {
        anyhow::anyhow!(
            "no pinned SHA-256 digest for llama.cpp release asset platform '{platform}'"
        )
    })
}

fn archive_sha256_for_platform(platform: &str) -> Option<&'static str> {
    match platform {
        "macos-arm64" => Some("f3e87f1664c09183a861f16758c55a5adc925672705cd3a47e3dc4444504c914"),
        "macos-x64" => Some("3cfdcb4c0a2071b470577cf26e182baf9a51edff09a8c89d9252d2d5c7d4b849"),
        "ubuntu-arm64" => Some("9692bd7147325654b69c62fb7780118c0a2579945a014dda53ca909b3bc7829e"),
        "ubuntu-x64" => Some("78ec7a1964710918030e85c132a0995b10b07e4f43001bdf54fe0fd48d1eb85b"),
        "ubuntu-vulkan-arm64" => {
            Some("608cc42c4718db8faba5b16b15f70b0d52c0a04512c6a6e39f05518b734e1cec")
        }
        "ubuntu-vulkan-x64" => {
            Some("ea12376a18e1c0cb39e32ada5ad797ec7e49f3b8a8583b9f81627a0b63e9c454")
        }
        "win-cpu-arm64" => Some("8407f05d4cc6e614eb8391de4c39af549428a6341603f1023355f5bd326611ba"),
        "win-cpu-x64" => Some("678d67405b12abd8ea3541ec6f501c10c9c15ba3cd0767bf090f79eb51168a17"),
        "win-cuda-12.4-x64" => {
            Some("28b08668627672d9f91ff716c32cd08e1d8d14b2e65427627951e5fc29d802a1")
        }
        "win-cuda-13.3-x64" => {
            Some("c275a6a5923e1d665d0b1d2b32ae266241a83936e9a5c2f0453b99d21877c88f")
        }
        "win-vulkan-x64" => {
            Some("5196ca655a6126ce368ee589c24604eaa491e5057c1edf2890c888f43764663d")
        }
        _ => None,
    }
}

/// The CUDA runtime archive that a Windows CUDA build needs beside it. Upstream
/// ships the `ggml-cuda` backend and the CUDA runtime DLLs as **two** archives;
/// installing only the first yields a `llama-server.exe` that fails to load its
/// backend at startup. `None` for every non-CUDA variant.
fn cudart_url(variant: LlamaVariant) -> Option<String> {
    if variant != LlamaVariant::Cuda {
        return None;
    }
    // `win-cuda-13.3-x64` → `cudart-llama-bin-win-cuda-13.3-x64.zip`.
    let slug = variant.asset_slug()?;
    Some(format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{TARGET_VERSION}/cudart-llama-bin-{slug}.zip"
    ))
}

fn cudart_sha256(variant: LlamaVariant) -> Option<&'static str> {
    let platform = variant.asset_slug()?;
    match platform {
        "win-cuda-12.4-x64" => {
            Some("8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6")
        }
        "win-cuda-13.3-x64" => {
            Some("1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e")
        }
        _ => None,
    }
}

/// llama.cpp ships Windows release assets as `.zip` and macOS/Linux assets as
/// `.tar.gz`. Requesting `.zip` for macOS/Linux 404s (the asset doesn't exist),
/// which is why install previously stalled on those platforms while Windows
/// worked.
fn archive_ext() -> &'static str {
    if cfg!(target_os = "windows") {
        "zip"
    } else {
        "tar.gz"
    }
}

/// True when the platform release asset is a `.zip` (Windows); `.tar.gz` otherwise.
fn archive_is_zip() -> bool {
    cfg!(target_os = "windows")
}

// ── LlamaCppDownloader ─────────────────────────────────────────────────────────

pub struct LlamaCppDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl LlamaCppDownloader {
    pub fn new() -> Self {
        Self {
            client: build_http_client(),
            on_progress: None,
        }
    }

    pub fn with_progress(mut self, cb: ProgressCallback) -> Self {
        self.on_progress = Some(cb);
        self
    }

    /// Ensure a llama.cpp build is installed at `<data dir>/engines/chat/llamacpp/`, picking
    /// the variant for this machine (accelerated when there is a usable GPU,
    /// CPU otherwise) unless the user pinned one.
    ///
    /// The release archive downloads through the global [`DownloadCenter`] (#456)
    /// so it streams to disk and shows in the overlay; we then extract the binary
    /// from the downloaded archive and place it atomically.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        let wanted = variant::resolve_from_preferences().await;
        self.ensure_variant_installed(downloads, wanted).await
    }

    /// Install `wanted` specifically, replacing whatever variant is on disk.
    ///
    /// Refuses an accelerated variant this node cannot run: an install that
    /// produces a `llama-server` which cannot load its backend is worse than no
    /// install at all, because the failure surfaces as a hung engine start.
    /// Callers that want "whatever works here" go through
    /// [`Self::ensure_installed`], which never asks for an unrunnable variant.
    pub async fn ensure_variant_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
        wanted: LlamaVariant,
    ) -> Result<()> {
        let device = variant::device();
        if !wanted.available_on(device) {
            anyhow::bail!(
                "cannot install the {} build of llama.cpp on this node: {}",
                wanted.as_str(),
                wanted
                    .unavailable_reason(device)
                    .unwrap_or("unsupported on this hardware")
            );
        }

        // One install at a time, process-wide. Several surfaces (onboarding,
        // embed, rerank, the install route) call this concurrently, and each
        // wipes and re-extracts the shared install dir — two at once delete
        // each other's libraries mid-extract. The fast path below runs under the
        // lock, so a caller that waited sees the finished install and returns.
        let _install = INSTALL_LOCK.lock().await;

        let dest = bin_path();
        let installed = variant::installed_variant();

        // Fast path: the right variant of the right release is already in place.
        // Both terms matter — the version alone would skip a variant SWITCH
        // (the tag does not change when the user moves from CPU to GPU), and the
        // variant alone would skip a Ryu-shipped llama.cpp upgrade.
        let store = VersionStore::load();
        if dest.exists() && installed == Some(wanted) {
            if let Some(stored) = store.versions.get("llamacpp") {
                if stored == TARGET_VERSION {
                    tracing::info!(
                        "llama.cpp {} ({}) already installed — skipping",
                        TARGET_VERSION,
                        wanted.as_str()
                    );
                    return Ok(());
                }
                tracing::warn!(
                    "llama.cpp version mismatch (stored={}, target={}), re-downloading",
                    stored,
                    TARGET_VERSION
                );
            }
        } else if installed.is_some_and(|i| i != wanted) {
            tracing::info!(
                "llama.cpp switching build: {} → {}",
                installed.map(LlamaVariant::as_str).unwrap_or("none"),
                wanted.as_str()
            );
        }

        let url = archive_url(wanted)?;
        tracing::info!("downloading llama.cpp ({}) from {url}", wanted.as_str());

        // Download the archive through the center to a deterministic temp dest
        // (so its own `.part`/resume works), then read it back to extract.
        let archive_dest = tmp_dir().join(format!(
            "llamacpp-{TARGET_VERSION}-{v}.{ext}",
            v = wanted.as_str(),
            ext = archive_ext()
        ));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Engine,
                role: crate::downloads::DownloadRole::Engine,
                label: format!("llama.cpp ({})", wanted.label()),
                url,
                dest: archive_dest,
                sha256: Some(archive_sha256(wanted)?.to_owned()),
                version_record: None,
            })
            .await
            .context("downloading llama.cpp archive")?;
        // Streamed from disk: CUDA builds are hundreds of MB, and reading the
        // whole archive into memory first doubled the install's peak RAM.
        let archive_file =
            std::fs::File::open(&archive_path).context("opening downloaded llama.cpp archive")?;

        // Wipe the previous build before extracting. Backends ship DIFFERENT
        // `ggml-*` shared libraries under the SAME names, and llama.cpp's
        // dynamic backend loader scans the binary's directory — a half-replaced
        // directory is a mixed set that loads and then fails at inference time.
        let bin_dir = variant::install_dir();
        if bin_dir.exists() {
            tokio::fs::remove_dir_all(&bin_dir)
                .await
                .with_context(|| format!("clearing {}", bin_dir.display()))?;
        }
        tokio::fs::create_dir_all(&bin_dir)
            .await
            .with_context(|| format!("creating {}", bin_dir.display()))?;

        // Extract the binary plus its sibling shared libs into the variant dir so
        // the engine's same-dir rpath resolves at launch (blocking I/O on a
        // thread-pool thread).
        let is_zip = archive_is_zip();
        let extract_dir = bin_dir.clone();
        let dest = tokio::task::spawn_blocking(move || {
            extract_binary_with_libs_from(
                std::io::BufReader::new(archive_file),
                "llama-server",
                &extract_dir,
                is_zip,
            )
        })
        .await
        .context("spawn_blocking for archive extraction")??;

        // The Windows CUDA build needs the CUDA runtime DLLs from a second
        // archive dropped beside it, or it cannot load `ggml-cuda`.
        if let Some(url) = cudart_url(wanted) {
            self.install_cudart(downloads, wanted, &url, &bin_dir)
                .await
                .context("installing the CUDA runtime for llama.cpp")?;
        }

        // Set executable bit on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms)?;
        }

        // Record which build is on disk BEFORE the version row: a crash between
        // the two then leaves "installed, unknown variant", which reinstalls,
        // rather than "right version, wrong backend", which would not.
        variant::record_installed(wanted).context("recording the installed llama.cpp variant")?;

        // Record version atomically — never clobbers a concurrently-installed engine.
        VersionStore::set_version_persisted("llamacpp", TARGET_VERSION)
            .context("writing versions.json")?;

        // The extracted binary is in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        tracing::info!(
            "llama.cpp {} ({}) installed at {}",
            TARGET_VERSION,
            wanted.as_str(),
            dest.display()
        );
        Ok(())
    }

    /// Download the CUDA runtime archive and unpack its DLLs beside the engine.
    /// Unlike the engine archive this has no single "wanted binary" — it is a
    /// bag of runtime libraries — so it extracts every file at its leaf name.
    async fn install_cudart(
        &self,
        downloads: &crate::downloads::DownloadCenter,
        variant: LlamaVariant,
        url: &str,
        bin_dir: &std::path::Path,
    ) -> Result<()> {
        let dest = tmp_dir().join(format!("llamacpp-cudart-{TARGET_VERSION}.zip"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Engine,
                role: crate::downloads::DownloadRole::Engine,
                label: "CUDA runtime".to_string(),
                url: url.to_string(),
                dest,
                sha256: Some(
                    cudart_sha256(variant)
                        .ok_or_else(|| {
                            anyhow::anyhow!("no pinned SHA-256 digest for CUDA runtime")
                        })?
                        .to_owned(),
                ),
                version_record: None,
            })
            .await
            .context("downloading the CUDA runtime archive")?;
        let archive_file = std::fs::File::open(&archive_path)
            .context("opening the downloaded CUDA runtime archive")?;
        let bin_dir = bin_dir.to_path_buf();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut zip = zip::ZipArchive::new(std::io::BufReader::new(archive_file))
                .context("opening the CUDA runtime archive")?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i)?;
                if entry.is_dir() {
                    continue;
                }
                let Some(name) = entry
                    .enclosed_name()
                    .and_then(|p| p.file_name().map(|f| f.to_os_string()))
                else {
                    continue;
                };
                // Runtime libraries only. The archive should contain nothing
                // else, but it is a remote zip being unpacked next to an
                // executable — extract by allowlist, not by whatever it names.
                if !name
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".dll")
                {
                    continue;
                }
                let mut out = std::fs::File::create(bin_dir.join(name))?;
                std::io::copy(&mut entry, &mut out)?;
            }
            Ok(())
        })
        .await
        .context("spawn_blocking for CUDA runtime extraction")??;
        let _ = tokio::fs::remove_file(&archive_path).await;
        Ok(())
    }

    /// Ensure the `llama-tts` text-to-speech binary is installed beside the
    /// engine in `<data dir>/engines/chat/llamacpp/`. Shares the same llama.cpp release
    /// archive as `llama-server`; used by the OuteTTS voice engine. Idempotent:
    /// skips the download when the binary already exists.
    ///
    /// Pulls the archive for the variant that is *installed*, so `llama-tts`
    /// and `llama-server` always come from one build and share one set of
    /// `ggml-*` libraries.
    pub async fn ensure_tts_binary(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<PathBuf> {
        let dest = variant::tts_path();
        if dest.exists() {
            return Ok(dest);
        }
        let _install = INSTALL_LOCK.lock().await;
        // Re-check under the lock: a variant install that held it may have
        // just placed (or wiped) the directory.
        if dest.exists() {
            return Ok(dest);
        }

        let wanted = match variant::installed_variant() {
            Some(v) => v,
            None => variant::resolve_from_preferences().await,
        };
        let url = archive_url(wanted)?;
        tracing::info!("downloading llama.cpp (for llama-tts) from {url}");
        // Download the archive through the center (shows in the overlay), then
        // extract llama-tts. Shares the llama-server release archive.
        let archive_dest = tmp_dir().join(format!(
            "llamacpp-tts-{TARGET_VERSION}-{v}.{ext}",
            v = wanted.as_str(),
            ext = archive_ext()
        ));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                role: crate::downloads::DownloadRole::Engine,
                label: "llama-tts".to_string(),
                url,
                dest: archive_dest,
                sha256: Some(archive_sha256(wanted)?.to_owned()),
                version_record: None,
            })
            .await
            .context("downloading llama.cpp archive for llama-tts")?;
        let archive_file =
            std::fs::File::open(&archive_path).context("opening downloaded llama-tts archive")?;

        // Extract llama-tts plus its sibling shared libs (shared with
        // llama-server) into the variant dir so its same-dir rpath resolves.
        let bin_dir = variant::install_dir();
        tokio::fs::create_dir_all(&bin_dir)
            .await
            .with_context(|| format!("creating {}", bin_dir.display()))?;
        let is_zip = archive_is_zip();
        let dest = tokio::task::spawn_blocking(move || {
            extract_binary_with_libs_from(
                std::io::BufReader::new(archive_file),
                "llama-tts",
                &bin_dir,
                is_zip,
            )
        })
        .await
        .context("spawn_blocking for archive extraction")??;
        let _ = tokio::fs::remove_file(&archive_path).await;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms)?;
        }

        tracing::info!("llama-tts installed at {}", dest.display());
        Ok(dest)
    }
}

impl Default for LlamaCppDownloader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{archive_sha256_for_platform, cudart_sha256};
    use crate::sidecar::providers::llamacpp::variant::LlamaVariant;

    #[test]
    fn every_release_archive_platform_has_a_pinned_digest() {
        for platform in [
            "macos-arm64",
            "macos-x64",
            "ubuntu-arm64",
            "ubuntu-x64",
            "ubuntu-vulkan-arm64",
            "ubuntu-vulkan-x64",
            "win-cpu-arm64",
            "win-cpu-x64",
            "win-cuda-12.4-x64",
            "win-cuda-13.3-x64",
            "win-vulkan-x64",
        ] {
            let digest = archive_sha256_for_platform(platform).expect(platform);
            assert_eq!(digest.len(), 64, "digest for {platform} must be SHA-256");
            assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn unsupported_release_assets_fail_closed() {
        assert!(archive_sha256_for_platform("unknown-platform").is_none());
        assert!(cudart_sha256(LlamaVariant::Cpu).is_none());
    }
}
