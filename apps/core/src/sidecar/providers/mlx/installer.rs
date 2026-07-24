//! MLX installer — checks for Python ≥ 3.9 and installs `mlx-lm` via pip.
//!
//! MLX is Apple's array framework and runs **only on Apple Silicon** (arm64
//! macOS). `pip install mlx-lm` fails on any other host, so every entry point
//! (install route, startup, `start()`) gates on [`registry::supported_on_node`]
//! first — the check is on the CORE NODE's own OS/arch, which is authoritative
//! because the desktop driving it may be a remote machine.

use anyhow::{bail, Context, Result};
use tokio::process::Command;

use crate::catalog::registry;
use crate::sidecar::download_manager::VersionStore;
use crate::win_process::NoWindow;

/// Pip package that provides the `mlx_lm` module (`python -m mlx_lm server`).
pub const PIP_PACKAGE: &str = "mlx-lm";

/// Bail unless this node is Apple Silicon. Shared by `ensure_installed` and the
/// provider's `start()` so the node-gate holds regardless of entry path.
pub fn ensure_supported() -> Result<()> {
    if registry::supported_on_node("mlx") {
        return Ok(());
    }
    bail!(
        "MLX requires Apple Silicon (arm64 macOS); this node is {}/{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Locate a usable Python interpreter (python3 or python) and verify it is ≥ 3.9.
/// Returns the command name that works on this system.
pub async fn python_cmd() -> Result<String> {
    for candidate in ["python3", "python"] {
        if let Ok(output) = Command::new(candidate)
            .args(["--version"])
            .no_window()
            .output()
            .await
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                // "Python 3.11.2" → "3.11.2"
                let version_str = text.strip_prefix("Python ").unwrap_or("").to_string();

                if is_version_sufficient(&version_str) {
                    return Ok(candidate.to_string());
                }

                bail!(
                    "Python {version_str} found but MLX requires Python ≥ 3.9. \
                     Please install a newer Python version."
                );
            }
        }
    }

    bail!(
        "Python not found. MLX requires Python ≥ 3.9. \
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
    ensure_supported()?;

    let store = VersionStore::load();

    // Fast path: already recorded in versions.json.
    if store.versions.contains_key("mlx") {
        tracing::info!("mlx already installed — skipping");
        return Ok(());
    }

    let python = python_cmd()
        .await
        .context("locating Python interpreter for MLX")?;

    tracing::info!("installing mlx-lm via pip ({python} -m pip install {PIP_PACKAGE})");

    let status = Command::new(&python)
        .args(["-m", "pip", "install", PIP_PACKAGE])
        .no_window()
        .status()
        .await
        .context("running `pip install mlx-lm`")?;

    if !status.success() {
        bail!("`{python} -m pip install {PIP_PACKAGE}` failed with {status}");
    }

    // Query the installed version.
    let version = Command::new(&python)
        .args(["-m", "pip", "show", PIP_PACKAGE])
        .no_window()
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

    VersionStore::set_version_persisted("mlx", &version).context("writing versions.json")?;

    tracing::info!("mlx-lm {version} installed");
    Ok(())
}
