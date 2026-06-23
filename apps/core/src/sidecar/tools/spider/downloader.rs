//! Spider CLI downloader - builds from source via cargo install.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{ryu_dir, ProgressCallback, ProgressEvent, VersionStore};

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "spider.exe"
    } else {
        "spider"
    };
    ryu_dir().join("bin").join(name)
}

const TARGET_VERSION: &str = "latest";

// ── SpiderDownloader ─────────────────────────────────────────────────────────

pub struct SpiderDownloader {
    on_progress: Option<ProgressCallback>,
}

impl SpiderDownloader {
    pub fn new() -> Self {
        Self { on_progress: None }
    }

    pub fn with_progress(mut self, cb: ProgressCallback) -> Self {
        self.on_progress = Some(cb);
        self
    }

    /// Ensure Spider CLI is installed via cargo install.
    pub async fn ensure_installed(&self) -> Result<()> {
        let dest = bin_path();

        // Fast path: binary present and already recorded.
        let store = VersionStore::load();
        if dest.exists() && store.versions.contains_key("spider") {
            tracing::info!("spider already installed — skipping");
            return Ok(());
        }

        // Check if cargo is available
        let cargo_check = std::process::Command::new("cargo")
            .arg("--version")
            .output()
            .context("cargo not found in PATH — is Rust installed?")?;

        if !cargo_check.status.success() {
            anyhow::bail!("cargo --version failed");
        }

        tracing::info!("Installing spider {} via cargo install", TARGET_VERSION);

        if let Some(cb) = self.on_progress.as_ref() {
            cb(ProgressEvent {
                name: "spider".to_string(),
                total_bytes: None,
                downloaded_bytes: 0,
                done: false,
            });
        }

        // Install spider_cli via cargo — always installs latest published version.
        let status = tokio::task::spawn_blocking(move || {
            std::process::Command::new("cargo")
                .args(["install", "spider_cli"])
                .status()
        })
        .await
        .context("spawn_blocking for cargo install")??;

        if !status.success() {
            anyhow::bail!(
                "cargo install spider_cli failed with exit code {:?}",
                status.code()
            );
        }

        // Note: cargo install puts binaries in ~/.cargo/bin/
        // We need to copy it to ~/.ryu/bin/
        let cargo_bin = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".cargo")
            .join("bin")
            .join(if cfg!(target_os = "windows") {
                "spider.exe"
            } else {
                "spider"
            });

        if cargo_bin.exists() {
            // Ensure ~/.ryu/bin exists
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }

            // Copy from cargo bin to ryu bin
            tokio::fs::copy(&cargo_bin, &dest).await.with_context(|| {
                format!("copying {} to {}", cargo_bin.display(), dest.display())
            })?;

            // Make executable on Unix.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&dest)?.permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&dest, perms)?;
            }
        } else {
            anyhow::bail!(
                "spider binary not found at {} after cargo install",
                cargo_bin.display()
            );
        }

        // Record version — query the installed binary for the real version string.
        let version = tokio::process::Command::new(&dest)
            .arg("--version")
            .output()
            .await
            .ok()
            .and_then(|o| {
                let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
                // Output is typically "spider 0.x.y" or just "0.x.y"
                text.split_whitespace().last().map(|s| s.to_string())
            })
            .unwrap_or_else(|| TARGET_VERSION.to_string());

        VersionStore::set_version_persisted("spider", &version).context("writing versions.json")?;

        // Ensure PATH includes ~/.ryu/bin
        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
        }

        if let Some(cb) = self.on_progress.as_ref() {
            cb(ProgressEvent {
                name: "spider".to_string(),
                total_bytes: None,
                downloaded_bytes: 1,
                done: true,
            });
        }

        tracing::info!("spider {} installed at {}", TARGET_VERSION, dest.display());
        Ok(())
    }
}

impl Default for SpiderDownloader {
    fn default() -> Self {
        Self::new()
    }
}
