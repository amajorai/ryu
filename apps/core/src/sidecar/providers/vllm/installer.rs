//! vLLM installer — checks for Python ≥ 3.9 and installs vllm via pip.

use anyhow::{bail, Context, Result};
use tokio::process::Command;

use crate::sidecar::download_manager::VersionStore;

/// Locate a usable Python interpreter (python3 or python) and verify it is ≥ 3.9.
/// Returns the command name that works on this system.
pub async fn python_cmd() -> Result<String> {
    for candidate in ["python3", "python"] {
        if let Ok(output) = Command::new(candidate).args(["--version"]).output().await {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                // "Python 3.11.2" → "3.11.2"
                let version_str = text.strip_prefix("Python ").unwrap_or("").to_string();

                if is_version_sufficient(&version_str) {
                    return Ok(candidate.to_string());
                }

                bail!(
                    "Python {version_str} found but vLLM requires Python ≥ 3.9. \
                     Please install a newer Python version."
                );
            }
        }
    }

    bail!(
        "Python not found. vLLM requires Python ≥ 3.9. \
         Install it from https://www.python.org/downloads/ or via your system package manager."
    )
}

/// Returns `true` if the version string (e.g. "3.11.2") is ≥ 3.9.
fn is_version_sufficient(version: &str) -> bool {
    let mut parts = version.splitn(3, '.');
    let major: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    major > 3 || (major == 3 && minor >= 9)
}

pub async fn ensure_installed() -> Result<()> {
    let store = VersionStore::load();

    // Fast path: already recorded in versions.json.
    if store.versions.contains_key("vllm") {
        tracing::info!("vllm already installed — skipping");
        return Ok(());
    }

    let python = python_cmd()
        .await
        .context("locating Python interpreter for vLLM")?;

    tracing::info!("installing vllm via pip ({python} -m pip install vllm)");

    let status = Command::new(&python)
        .args(["-m", "pip", "install", "vllm"])
        .status()
        .await
        .context("running `pip install vllm`")?;

    if !status.success() {
        bail!("`{python} -m pip install vllm` failed with {status}");
    }

    // Query the installed version.
    let version = Command::new(&python)
        .args(["-m", "pip", "show", "vllm"])
        .output()
        .await
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .find(|l| l.starts_with("Version:"))
                .and_then(|l| l.strip_prefix("Version:"))
                .map(|v| v.trim().to_string())
        })
        .unwrap_or_else(|| "latest".to_string());

    VersionStore::set_version_persisted("vllm", &version).context("writing versions.json")?;

    tracing::info!("vllm {version} installed");
    Ok(())
}
