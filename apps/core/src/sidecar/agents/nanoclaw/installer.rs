//! NanoClaw installer — runs the official Docker sandbox install script.
//!
//! Supported platforms:
//!   - macOS Apple Silicon (aarch64)  → bash install script
//!   - Windows x86_64                 → WSL bash install script
//!
//! Linux and macOS Intel are NOT supported upstream.

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::sidecar::download_manager::VersionStore;

pub async fn ensure_installed() -> Result<()> {
    // Fast path: already recorded.
    let store = VersionStore::load();
    if store.versions.contains_key("nanoclaw") {
        tracing::info!("nanoclaw already installed — skipping");
        return Ok(());
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        install_macos().await
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        install_windows().await
    }

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        anyhow::bail!(
            "nanoclaw only supports macOS Apple Silicon and Windows x86_64. \
             Linux and macOS Intel are not yet supported."
        )
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
async fn install_macos() -> Result<()> {
    tracing::info!("installing nanoclaw docker sandboxes (macOS Apple Silicon)");

    let status = Command::new("bash")
        .args([
            "-c",
            "curl -fsSL https://nanoclaw.dev/install-docker-sandboxes.sh | bash",
        ])
        .status()
        .await
        .context("running nanoclaw install script")?;

    if !status.success() {
        anyhow::bail!("nanoclaw install script failed with {}", status);
    }

    record_installed()
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
async fn install_windows() -> Result<()> {
    tracing::info!("installing nanoclaw docker sandboxes (Windows x86 via WSL)");

    // Verify WSL is available.
    let wsl_check = Command::new("wsl").args(["--status"]).output().await;

    match wsl_check {
        Ok(out) if out.status.success() => {}
        _ => anyhow::bail!(
            "WSL is required to install nanoclaw on Windows but was not found. \
             Install WSL with: wsl --install"
        ),
    }

    let status = Command::new("wsl")
        .args([
            "bash",
            "-c",
            "curl -fsSL https://nanoclaw.dev/install-docker-sandboxes-windows.sh | bash",
        ])
        .status()
        .await
        .context("running nanoclaw WSL install script")?;

    if !status.success() {
        anyhow::bail!("nanoclaw WSL install script failed with {}", status);
    }

    record_installed()
}

fn record_installed() -> Result<()> {
    let version = std::process::Command::new("nanoclaw")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            text.split_whitespace().last().map(|s| s.to_string())
        })
        .unwrap_or_else(|| "latest".to_string());

    VersionStore::set_version_persisted("nanoclaw", &version).context("writing versions.json")?;
    tracing::info!("nanoclaw installed successfully");
    Ok(())
}
