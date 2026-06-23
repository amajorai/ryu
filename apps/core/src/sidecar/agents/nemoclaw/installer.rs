//! NemoClaw installer — runs the official NVIDIA install script
//! (`curl -fsSL https://nvidia.com/nemoclaw.sh | bash`) and copies
//! the resulting binary into `~/.ryu/bin/` so it lives alongside
//! every other Ryu-managed binary.

use std::path::PathBuf;

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::sidecar::download_manager::{bin_dir, VersionStore};

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "nemoclaw.exe"
    } else {
        "nemoclaw"
    };
    bin_dir().join(name)
}

/// Returns the path to the nemoclaw binary under `~/.ryu/bin`.
pub fn binary_path() -> PathBuf {
    bin_path()
}

pub async fn ensure_installed() -> Result<()> {
    let dest = bin_path();
    let store = VersionStore::load();

    if dest.exists() && store.versions.contains_key("nemoclaw") {
        tracing::info!(
            "nemoclaw already installed at {} — skipping",
            dest.display()
        );
        return Ok(());
    }

    std::fs::create_dir_all(bin_dir()).context("creating ~/.ryu/bin")?;

    // Run the official NVIDIA NemoClaw install script
    tracing::info!("installing nemoclaw via NVIDIA install script");

    let status = Command::new("bash")
        .args(["-c", "curl -fsSL https://nvidia.com/nemoclaw.sh | bash"])
        .status()
        .await
        .context("running `curl -fsSL https://nvidia.com/nemoclaw.sh | bash`")?;

    if !status.success() {
        anyhow::bail!("nemoclaw install script failed with {status}");
    }

    // Copy the binary the script placed in PATH into ~/.ryu/bin/
    copy_to_ryu_bin().await?;

    // Query the binary for its real version.
    let version = Command::new(&dest)
        .arg("--version")
        .output()
        .await
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            text.split_whitespace().last().map(|s| s.to_string())
        })
        .unwrap_or_else(|| "latest".to_string());

    VersionStore::set_version_persisted("nemoclaw", &version).context("writing versions.json")?;

    tracing::info!("nemoclaw installed at {}", dest.display());
    Ok(())
}

/// Locate the nemoclaw binary that the install script placed somewhere in PATH
/// and hard-copy it into `~/.ryu/bin/` so it is managed alongside all other
/// Ryu binaries regardless of where the script chose to put it.
async fn copy_to_ryu_bin() -> Result<()> {
    let dest = bin_path();
    if dest.exists() {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    let output = Command::new("where").arg("nemoclaw").output().await;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new("which").arg("nemoclaw").output().await;

    let output = output.context("locating nemoclaw binary with which/where")?;
    if !output.status.success() {
        anyhow::bail!(
            "nemoclaw binary not found in PATH after install — \
             the install script may have failed silently"
        );
    }

    let found = String::from_utf8_lossy(&output.stdout);
    let src = PathBuf::from(found.trim());

    std::fs::copy(&src, &dest)
        .with_context(|| format!("copying {} → {}", src.display(), dest.display()))?;

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .context("setting nemoclaw binary permissions")?;
    }

    tracing::info!("nemoclaw binary copied to {}", dest.display());
    Ok(())
}
