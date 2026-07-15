//! Screenpipe installer — installs screenpipe@latest via npm into `~/.ryu`.

use std::path::PathBuf;

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::sidecar::download_manager::{ryu_dir, ProgressCallback, ProgressEvent, VersionStore};
use crate::win_process::NoWindow;

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "screenpipe.cmd"
    } else {
        "screenpipe"
    };
    ryu_dir().join("bin").join(name)
}

// ── ScreenpipeDownloader ──────────────────────────────────────────────────────

pub struct ScreenpipeDownloader {
    on_progress: Option<ProgressCallback>,
}

impl ScreenpipeDownloader {
    pub fn new() -> Self {
        Self { on_progress: None }
    }

    pub fn with_progress(mut self, cb: ProgressCallback) -> Self {
        self.on_progress = Some(cb);
        self
    }

    /// Install screenpipe@latest via `npm install --prefix ~/.ryu screenpipe@latest`,
    /// which places the binary wrapper at `~/.ryu/bin/screenpipe`.
    pub async fn ensure_installed(&self) -> Result<()> {
        let dest = bin_path();

        // Fast path: binary present and version recorded.
        let store = VersionStore::load();
        if dest.exists() && store.versions.contains_key("screenpipe") {
            tracing::info!(
                "screenpipe already installed at {} — skipping",
                dest.display()
            );
            return Ok(());
        }

        let prefix = ryu_dir().to_string_lossy().into_owned();
        tracing::info!("installing screenpipe via npm --prefix {prefix}");

        if let Some(cb) = self.on_progress.as_ref() {
            cb(ProgressEvent {
                name: "screenpipe".to_string(),
                total_bytes: None,
                downloaded_bytes: 0,
                done: false,
            });
        }

        let status = Command::new("npm")
            .args([
                "install",
                "--prefix",
                &prefix,
                "screenpipe@latest",
                "--ignore-scripts",
            ])
            .no_window()
            .status()
            .await
            .context("running `npm install --prefix ~/.ryu screenpipe@latest --ignore-scripts`")?;

        if !status.success() {
            anyhow::bail!("`npm install --prefix {prefix} screenpipe@latest --ignore-scripts` failed with {status}");
        }

        // Query the installed version from npm.
        let version = Command::new("npm")
            .args(["view", "screenpipe", "version"])
            .no_window()
            .output()
            .await
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "latest".to_string());

        VersionStore::set_version_persisted("screenpipe", &version)
            .context("writing versions.json")?;

        // Ensure PATH includes ~/.ryu/bin
        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
        }

        if let Some(cb) = self.on_progress.as_ref() {
            cb(ProgressEvent {
                name: "screenpipe".to_string(),
                total_bytes: None,
                downloaded_bytes: 1,
                done: true,
            });
        }

        tracing::info!("screenpipe installed at {}", dest.display());
        Ok(())
    }
}

impl Default for ScreenpipeDownloader {
    fn default() -> Self {
        Self::new()
    }
}
