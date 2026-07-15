//! OpenClaw installer — installs openclaw@latest into `~/.ryu` via npm,
//! placing the binary at `~/.ryu/bin/openclaw` without running onboarding.

use std::path::PathBuf;

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::sidecar::download_manager::{ryu_dir, VersionStore};
use crate::win_process::NoWindow;

fn bin_path() -> PathBuf {
    // npm creates a `.cmd` wrapper on Windows, a plain script on Unix.
    let name = if cfg!(target_os = "windows") {
        "openclaw.cmd"
    } else {
        "openclaw"
    };
    ryu_dir().join("bin").join(name)
}

/// Returns the path to the openclaw binary under `~/.ryu/bin`.
pub fn binary_path() -> PathBuf {
    bin_path()
}

pub async fn ensure_installed() -> Result<()> {
    let dest = bin_path();

    // Fast path: binary present and version recorded.
    let store = VersionStore::load();
    if dest.exists() && store.versions.contains_key("openclaw") {
        tracing::info!(
            "openclaw already installed at {} — skipping",
            dest.display()
        );
        return Ok(());
    }

    let prefix = ryu_dir().to_string_lossy().into_owned();
    tracing::info!("installing openclaw via npm --prefix {prefix}");

    // `npm install --prefix ~/.ryu openclaw@latest` installs the package under
    // `~/.ryu/node_modules` and writes the binary wrapper to `~/.ryu/bin/openclaw`
    // without touching the global npm prefix or invoking any post-install daemon.
    let status = Command::new("npm")
        .args(["install", "--prefix", &prefix, "openclaw@latest"])
        .no_window()
        .status()
        .await
        .context("running `npm install --prefix ~/.ryu openclaw@latest`")?;

    if !status.success() {
        anyhow::bail!("`npm install --prefix {prefix} openclaw@latest` failed with {status}");
    }

    // Query the installed version from npm.
    let version = tokio::process::Command::new("npm")
        .args(["view", "openclaw", "version"])
        .no_window()
        .output()
        .await
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "latest".to_string());

    VersionStore::set_version_persisted("openclaw", &version).context("writing versions.json")?;

    tracing::info!("openclaw installed at {}", dest.display());
    Ok(())
}
