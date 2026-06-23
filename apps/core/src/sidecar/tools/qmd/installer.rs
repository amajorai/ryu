//! QMD installer — installs @tobilu/qmd@latest into `~/.ryu` via npm,
//! placing the binary at `~/.ryu/bin/qmd` without running onboarding.

use std::path::PathBuf;

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::sidecar::download_manager::{ryu_dir, VersionStore};

fn bin_path() -> PathBuf {
    // npm creates a `.cmd` wrapper on Windows, a plain script on Unix.
    let name = if cfg!(target_os = "windows") {
        "qmd.cmd"
    } else {
        "qmd"
    };
    ryu_dir().join("bin").join(name)
}

/// Returns the path to the qmd binary under `~/.ryu/bin`.
pub fn binary_path() -> PathBuf {
    bin_path()
}

pub async fn ensure_installed() -> Result<()> {
    let dest = bin_path();

    // Fast path: binary present and version recorded.
    let store = VersionStore::load();
    if dest.exists() && store.versions.contains_key("qmd") {
        tracing::info!("qmd already installed at {} — skipping", dest.display());
        return Ok(());
    }

    let prefix = ryu_dir().to_string_lossy().into_owned();
    tracing::info!("installing @tobilu/qmd via npm --prefix {prefix}");

    // `npm install --prefix ~/.ryu @tobilu/qmd@latest` installs the package under
    // `~/.ryu/node_modules` and writes the binary wrapper to `~/.ryu/bin/qmd`
    // without touching the global npm prefix or invoking any post-install daemon.
    let status = Command::new("npm")
        .args(["install", "--prefix", &prefix, "@tobilu/qmd@latest"])
        .status()
        .await
        .context("running `npm install --prefix ~/.ryu @tobilu/qmd@latest`")?;

    if !status.success() {
        anyhow::bail!("`npm install --prefix {prefix} @tobilu/qmd@latest` failed with {status}");
    }

    // Query the installed version from npm.
    let version = tokio::process::Command::new("npm")
        .args(["view", "@tobilu/qmd", "version"])
        .output()
        .await
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "latest".to_string());

    VersionStore::set_version_persisted("qmd", &version).context("writing versions.json")?;

    tracing::info!("qmd installed at {}", dest.display());
    Ok(())
}
