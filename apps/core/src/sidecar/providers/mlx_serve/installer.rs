//! mlx-serve installer — Apple Silicon, PATH-adopt + Homebrew fallback.
//!
//! mlx-serve is a native Zig server distributed as a Homebrew formula and
//! release binary. Ryu does not build or vendor it, and it never downloads the
//! runtime's model cache. The installer adopts an existing executable first,
//! then uses the upstream Homebrew tap when the user explicitly installs the
//! engine from Ryu's catalog.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use tokio::process::Command;

use crate::catalog::registry;
use crate::sidecar::download_manager::{ryu_dir, VersionStore};
use crate::win_process::NoWindow;

/// Version-store key shared by the catalog, manager, and install route.
pub const VERSION_KEY: &str = "mlx-serve";

/// Upstream repository used by the documented Homebrew tap.
pub const GIT_URL: &str = "https://github.com/ddalcu/mlx-serve";

/// Bail unless this node satisfies the current native mlx-serve platform gate.
/// The check is repeated by the provider's `start()` path so a direct API call
/// cannot bypass the node gate enforced by the install route.
pub fn ensure_supported() -> Result<()> {
    if registry::supported_on_node(VERSION_KEY) {
        return Ok(());
    }
    bail!(
        "mlx-serve requires Apple Silicon macOS 26.2+; this node is {}/{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// The optional Ryu-managed location for an operator-provided binary.
pub fn managed_binary_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "mlx-serve.exe"
    } else {
        "mlx-serve"
    };
    ryu_dir().join("bin").join(name)
}

fn candidates() -> Vec<String> {
    let mut values = Vec::new();
    if let Ok(value) = std::env::var("RYU_MLX_SERVE_BIN") {
        if !value.trim().is_empty() {
            values.push(value);
        }
    }
    values.push(managed_binary_path().to_string_lossy().into_owned());
    if let Some(home) = dirs::home_dir() {
        values.push(
            home.join(".local/bin/mlx-serve")
                .to_string_lossy()
                .into_owned(),
        );
    }
    values.push("/opt/homebrew/bin/mlx-serve".to_string());
    values.push("/usr/local/bin/mlx-serve".to_string());
    values.push("mlx-serve".to_string());
    values
}

/// Whether an executable Ryu can launch is available now.
///
/// This synchronous probe is used by Core's install-status endpoint. It checks
/// the same candidates as the async launcher and asks the binary for its
/// version rather than trusting a stale `versions.json` marker.
pub fn binary_is_available() -> bool {
    candidates().into_iter().any(|candidate| {
        if candidate != "mlx-serve" && !PathBuf::from(&candidate).is_file() {
            return false;
        }
        std::process::Command::new(&candidate)
            .arg("--version")
            .no_window()
            .output()
            .is_ok_and(|output| output.status.success())
    })
}

/// Resolve the first executable Ryu can launch, preferring an explicit path.
pub async fn mlx_serve_binary() -> Option<String> {
    for candidate in candidates() {
        if candidate != "mlx-serve" && !PathBuf::from(&candidate).is_file() {
            continue;
        }
        if let Ok(output) = Command::new(&candidate)
            .arg("--version")
            .no_window()
            .output()
            .await
        {
            if output.status.success() {
                return Some(candidate);
            }
        }
    }
    None
}

async fn brew_available() -> bool {
    Command::new("brew")
        .arg("--version")
        .no_window()
        .output()
        .await
        .is_ok_and(|output| output.status.success())
}

/// Ensure the native mlx-serve executable exists and return its launch path.
pub async fn ensure_installed() -> Result<String> {
    ensure_supported()?;

    if let Some(binary) = mlx_serve_binary().await {
        record_version(&binary).await;
        return Ok(binary);
    }

    if !brew_available().await {
        bail!(
            "mlx-serve is not installed and Homebrew was not found. Install the official binary \
             from https://github.com/ddalcu/mlx-serve/releases or install Homebrew, then try \
             the MLX Serve engine again."
        );
    }

    tracing::info!("installing mlx-serve via Homebrew tap {GIT_URL}");
    let tap_status = Command::new("brew")
        .args(["tap", "ddalcu/mlx-serve", GIT_URL])
        .no_window()
        .status()
        .await
        .context("running the documented mlx-serve Homebrew tap")?;
    if !tap_status.success() {
        bail!("`brew tap ddalcu/mlx-serve {GIT_URL}` failed with {tap_status}");
    }

    // Homebrew 6 requires a custom-tap formula to be explicitly trusted before
    // installation. Trust only the exact formula the user selected, never the
    // whole tap or an arbitrary executable.
    let trust_status = Command::new("brew")
        .args(["trust", "--formula", "ddalcu/mlx-serve/mlx-serve"])
        .no_window()
        .status()
        .await
        .context("trusting the mlx-serve Homebrew formula")?;
    if !trust_status.success() {
        bail!("`brew trust --formula ddalcu/mlx-serve/mlx-serve` failed with {trust_status}");
    }

    let install_status = Command::new("brew")
        .args(["install", "mlx-serve"])
        .no_window()
        .status()
        .await
        .context("running `brew install mlx-serve`")?;
    if !install_status.success() {
        bail!("`brew install mlx-serve` failed with {install_status}");
    }

    let binary = mlx_serve_binary()
        .await
        .context("mlx-serve installed but its executable is not resolvable on PATH")?;
    record_version(&binary).await;
    Ok(binary)
}

async fn record_version(binary: &str) {
    let version = Command::new(binary)
        .arg("--version")
        .no_window()
        .output()
        .await
        .ok()
        .and_then(|output| {
            version_from_output(
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr),
            )
        })
        .unwrap_or_else(|| "adopted".to_string());

    if let Err(error) = VersionStore::set_version_persisted(VERSION_KEY, &version) {
        tracing::warn!(error = %error, "could not persist mlx-serve version");
    }
}

/// Extract the mlx-serve version without mistaking its startup diagnostics for
/// the version. Current binaries print a memory-cap line before the actual
/// `mlx-serve 26.8.10` line.
fn version_from_output(stdout: &str, stderr: &str) -> Option<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .find_map(|line| {
            line.trim()
                .strip_prefix("mlx-serve ")
                .and_then(|rest| rest.split_whitespace().next())
                .map(str::to_owned)
        })
        .or_else(|| {
            stdout
                .split_whitespace()
                .chain(stderr.split_whitespace())
                .find(|token| {
                    let mut parts = token.trim_start_matches('v').split('.');
                    parts.next().is_some_and(|part| part.parse::<u32>().is_ok())
                        && parts.next().is_some_and(|part| part.parse::<u32>().is_ok())
                })
                .map(str::to_owned)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_binary_uses_the_engine_name() {
        assert!(managed_binary_path()
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("mlx-serve")));
    }

    #[test]
    fn version_key_is_stable() {
        assert_eq!(VERSION_KEY, "mlx-serve");
    }

    #[test]
    fn version_parser_skips_memory_diagnostics() {
        let version = version_from_output(
            "[mem] MLX buffer-pool cap 2048 MB\nmlx-serve 26.8.10\nmlx 0.32.0\n",
            "",
        );
        assert_eq!(version.as_deref(), Some("26.8.10"));
    }
}
