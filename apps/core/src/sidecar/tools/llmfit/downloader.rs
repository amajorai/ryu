//! llmfit downloader — installs via `cargo install llmfit`.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{ryu_dir, ProgressCallback, ProgressEvent, VersionStore};

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "llmfit.exe"
    } else {
        "llmfit"
    };
    ryu_dir().join("bin").join(name)
}

// ── LlmFitDownloader ──────────────────────────────────────────────────────────

pub struct LlmFitDownloader {
    on_progress: Option<ProgressCallback>,
}

impl LlmFitDownloader {
    pub fn new() -> Self {
        Self { on_progress: None }
    }

    pub fn with_progress(mut self, cb: ProgressCallback) -> Self {
        self.on_progress = Some(cb);
        self
    }

    /// Ensure llmfit is installed via `cargo install llmfit`.
    pub async fn ensure_installed(&self) -> Result<()> {
        let dest = bin_path();

        // Fast path: binary present and version recorded.
        let store = VersionStore::load();
        if dest.exists() && store.versions.contains_key("llmfit") {
            tracing::info!("llmfit already installed at {} — skipping", dest.display());
            return Ok(());
        }

        // Verify cargo is available.
        let cargo_check = std::process::Command::new("cargo")
            .arg("--version")
            .output()
            .context("cargo not found in PATH — is Rust installed?")?;

        if !cargo_check.status.success() {
            anyhow::bail!("cargo --version failed");
        }

        tracing::info!("installing llmfit via cargo install");

        if let Some(cb) = self.on_progress.as_ref() {
            cb(ProgressEvent {
                name: "llmfit".to_string(),
                total_bytes: None,
                downloaded_bytes: 0,
                done: false,
            });
        }

        let status = tokio::task::spawn_blocking(move || {
            std::process::Command::new("cargo")
                .args(["install", "llmfit"])
                .status()
        })
        .await
        .context("spawn_blocking for cargo install")??;

        if !status.success() {
            anyhow::bail!(
                "cargo install llmfit failed with exit code {:?}",
                status.code()
            );
        }

        // cargo install puts binaries in ~/.cargo/bin/ — copy to ~/.ryu/bin/.
        let cargo_bin = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".cargo")
            .join("bin")
            .join(if cfg!(target_os = "windows") {
                "llmfit.exe"
            } else {
                "llmfit"
            });

        if cargo_bin.exists() {
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::copy(&cargo_bin, &dest).await.with_context(|| {
                format!("copying {} to {}", cargo_bin.display(), dest.display())
            })?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&dest)?.permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&dest, perms)?;
            }
        } else {
            anyhow::bail!(
                "llmfit binary not found at {} after cargo install",
                cargo_bin.display()
            );
        }

        // Record the installed version.
        let version = tokio::process::Command::new(&dest)
            .arg("--version")
            .output()
            .await
            .ok()
            .and_then(|o| {
                let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
                // Output is typically "llmfit 0.7.4"
                text.split_whitespace().last().map(|s| s.to_string())
            })
            .unwrap_or_else(|| "latest".to_string());

        VersionStore::set_version_persisted("llmfit", &version).context("writing versions.json")?;

        if let Some(cb) = self.on_progress.as_ref() {
            cb(ProgressEvent {
                name: "llmfit".to_string(),
                total_bytes: None,
                downloaded_bytes: 1,
                done: true,
            });
        }

        tracing::info!("llmfit installed at {}", dest.display());
        Ok(())
    }
}

impl Default for LlmFitDownloader {
    fn default() -> Self {
        Self::new()
    }
}
