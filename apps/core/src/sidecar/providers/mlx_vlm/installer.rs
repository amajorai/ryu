//! MLX-VLM installer — checks for Python ≥ 3.10 and installs the pinned
//! `mlx-vlm` release via pip.
//!
//! MLX-VLM is the vision/omni sibling of `mlx-lm` (Blaizzy/mlx-vlm): it serves
//! Vision-Language and Omni models (image / audio / video input) on Apple's MLX
//! framework, so like `mlx-lm` it runs **only on Apple Silicon** (arm64 macOS).
//! `pip install mlx-vlm` fails on any other host, so every entry point (install
//! route, startup, `start()`) gates on [`registry::supported_on_node`] first —
//! the check is on the CORE NODE's own OS/arch, which is authoritative because
//! the desktop driving it may be a remote machine.

use anyhow::{bail, Context, Result};
use tokio::process::Command;

use crate::catalog::registry;
use crate::sidecar::download_manager::VersionStore;
use crate::win_process::NoWindow;

/// Pip package that provides the `mlx_vlm` module (`python -m mlx_vlm.server`).
pub const PIP_PACKAGE: &str = "mlx-vlm";

/// The pinned requirement Ryu installs. The `mlx-vlm` native launch catalog in
/// `ryu-engines` is verified against this release's `mlx_vlm.server` CLI.
pub const PIP_REQUIREMENT: &str = "mlx-vlm==0.7.8";

/// The version [`PIP_REQUIREMENT`] pins, as `pip show` reports it.
pub const PINNED_VERSION: &str = "0.7.8";

/// Key under which the installed version is recorded in `versions.json`.
pub const VERSION_KEY: &str = "mlx-vlm";

/// Bail unless this node is Apple Silicon. Shared by `ensure_installed` and the
/// provider's `start()` so the node-gate holds regardless of entry path.
pub fn ensure_supported() -> Result<()> {
    if registry::supported_on_node(VERSION_KEY) {
        return Ok(());
    }
    bail!(
        "MLX-VLM requires Apple Silicon (arm64 macOS); this node is {}/{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Locate the Python interpreter that runs MLX-VLM. An install from before the
/// pin keeps running on the Python it was installed with (≥ 3.9); a fresh or
/// pinned install needs ≥ 3.10. Returns the command name that works.
pub async fn python_cmd() -> Result<String> {
    let recorded = VersionStore::load().versions.get(VERSION_KEY).cloned();
    python_cmd_at_least(run_min_minor(recorded.as_deref())).await
}

/// The lowest Python 3 minor version that runs the recorded install.
fn run_min_minor(recorded: Option<&str>) -> u32 {
    match recorded {
        Some(version) if version.trim() != PINNED_VERSION => 9,
        _ => 10,
    }
}

/// Locate python3 or python and verify it is at least `3.{min_minor}`.
async fn python_cmd_at_least(min_minor: u32) -> Result<String> {
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

                if is_version_sufficient(&version_str, min_minor) {
                    return Ok(candidate.to_string());
                }

                bail!(
                    "Python {version_str} found but MLX-VLM requires Python ≥ 3.{min_minor}. \
                     Please install a newer Python version."
                );
            }
        }
    }

    bail!(
        "Python not found. MLX-VLM requires Python ≥ 3.{min_minor}. \
         Install it from https://www.python.org/downloads/ or via your system package manager."
    )
}

/// Returns `true` if the version string (e.g. "3.11.2") is ≥ `3.{min_minor}`
/// (the pinned mlx-vlm declares `requires_python >= 3.10`).
fn is_version_sufficient(version: &str, min_minor: u32) -> bool {
    let mut parts = version.splitn(3, '.');
    let major: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    major > 3 || (major == 3 && minor >= min_minor)
}

pub async fn ensure_installed() -> Result<()> {
    ensure_supported()?;

    let store = VersionStore::load();

    // Fast path: an install is already recorded in versions.json. An install
    // from before the pin is kept rather than upgraded in the user's Python on
    // start (it may run on a Python the pinned release no longer supports); a
    // native launch option that release lacks fails only when it is set.
    let recorded = store.versions.get(VERSION_KEY).map(String::as_str);
    if !needs_install(recorded) {
        tracing::info!(
            "mlx-vlm {} already installed — skipping",
            recorded.unwrap_or_default()
        );
        if let Ok(python) = python_cmd().await {
            crate::sidecar::external_runtime::remediate_installed_pip_floor(VERSION_KEY, &python)
                .await;
        }
        return Ok(());
    }

    let python = python_cmd_at_least(10)
        .await
        .context("locating Python interpreter for MLX-VLM")?;

    tracing::info!("installing mlx-vlm via pip ({python} -m pip install {PIP_REQUIREMENT})");

    let pip_args = crate::sidecar::external_runtime::pip_install_package_args(&[PIP_REQUIREMENT])
        .context("writing the pip security constraints file")?;
    let status = Command::new(&python)
        .args(&pip_args)
        .no_window()
        .status()
        .await
        .context("running `pip install mlx-vlm`")?;

    if !status.success() {
        bail!("`{python} -m pip install {PIP_REQUIREMENT}` failed with {status}");
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
        .unwrap_or_else(|| PINNED_VERSION.to_string());

    VersionStore::set_version_persisted(VERSION_KEY, &version).context("writing versions.json")?;

    tracing::info!("mlx-vlm {version} installed");
    Ok(())
}

/// Whether `pip install` must run for the version recorded in `versions.json`.
fn needs_install(recorded: Option<&str>) -> bool {
    recorded.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_install_is_kept_and_a_fresh_one_gets_the_pin() {
        assert!(needs_install(None));
        assert!(!needs_install(Some("0.6.2")));
        assert!(!needs_install(Some(PINNED_VERSION)));
        assert!(PIP_REQUIREMENT.ends_with(&format!("=={PINNED_VERSION}")));
    }

    #[test]
    fn a_pre_pin_install_keeps_running_on_python_3_9() {
        assert_eq!(run_min_minor(Some("0.6.2")), 9);
        assert_eq!(run_min_minor(Some(PINNED_VERSION)), 10);
        assert_eq!(run_min_minor(None), 10);
        assert!(is_version_sufficient("3.9.6", 9));
        assert!(!is_version_sufficient("3.9.6", 10));
        assert!(is_version_sufficient("3.12.1", 10));
    }
}
