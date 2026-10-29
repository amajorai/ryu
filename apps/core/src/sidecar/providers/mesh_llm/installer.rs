//! Mesh LLM installer and binary resolution.
//!
//! Mesh LLM is an OpenAI-compatible distributed inference runtime. Ryu does not
//! rebuild or vendor it: the engine adopts an existing `mesh-llm` executable and
//! only attempts the documented Apple Silicon Homebrew install when no executable
//! is available. Model weights and mesh membership remain Mesh LLM's own config.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use tokio::process::Command;

use ryu_sidecar_runtime::layout::EngineGroup;

use crate::sidecar::download_manager::{engine_dir, VersionStore};
use crate::win_process::NoWindow;

/// Version-store key shared by the catalog, manager, and install route.
pub const VERSION_KEY: &str = "mesh-llm";

/// Ryu's optional managed-binary location. The normal path is PATH adoption;
/// this location (`<data dir>/engines/chat/mesh-llm/`) lets an operator keep
/// the executable inside Ryu's own engine tree.
pub fn managed_binary_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "mesh-llm.exe"
    } else {
        "mesh-llm"
    };
    engine_dir(EngineGroup::Chat, "mesh-llm").join(name)
}

fn candidates() -> Vec<String> {
    let mut values = Vec::new();
    if let Ok(value) = std::env::var("RYU_MESH_LLM_BIN") {
        if !value.trim().is_empty() {
            values.push(value);
        }
    }
    values.push(managed_binary_path().to_string_lossy().into_owned());
    if let Some(home) = dirs::home_dir() {
        values.push(
            home.join(".local/bin/mesh-llm")
                .to_string_lossy()
                .into_owned(),
        );
    }
    values.push("/opt/homebrew/bin/mesh-llm".to_string());
    values.push("/usr/local/bin/mesh-llm".to_string());
    values.push("mesh-llm".to_string());
    values
}

/// Whether an executable that Ryu can launch is available now.
///
/// This synchronous probe is used by Core's install-status endpoint, which is
/// synchronous by design. It checks the same candidates as the async launcher.
pub fn binary_is_available() -> bool {
    for candidate in candidates() {
        if candidate != "mesh-llm" && !PathBuf::from(&candidate).is_file() {
            continue;
        }
        if std::process::Command::new(&candidate)
            .arg("--version")
            .no_window()
            .output()
            .is_ok_and(|output| output.status.success())
        {
            return true;
        }
    }
    false
}

/// Resolve the first executable Ryu can launch, preferring an explicit path and
/// then the managed/PATH locations.
pub async fn mesh_llm_binary() -> Option<String> {
    for candidate in candidates() {
        if candidate != "mesh-llm" && !PathBuf::from(&candidate).is_file() {
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

/// Ensure a Mesh LLM executable is present and return the path/command to run.
pub async fn ensure_installed() -> Result<String> {
    if let Some(binary) = mesh_llm_binary().await {
        record_version(&binary).await;
        return Ok(binary);
    }

    // The upstream project documents this formula for Apple Silicon. Do not run
    // its curl|bash installer from inside Ryu: a package-manager action is visible,
    // reversible, and does not turn a remote script into an implicit Ryu binary.
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) && brew_available().await {
        tracing::info!("installing Mesh LLM via `brew install Mesh-LLM/tap/mesh-llm`");
        let status = Command::new("brew")
            .args(["install", "Mesh-LLM/tap/mesh-llm"])
            .no_window()
            .status()
            .await
            .context("running the documented Mesh LLM Homebrew install")?;
        if status.success() {
            if let Some(binary) = mesh_llm_binary().await {
                record_version(&binary).await;
                return Ok(binary);
            }
        }
    }

    bail!(
        "Mesh LLM is not installed. Install it from https://github.com/Mesh-LLM/mesh-llm \
         (Apple Silicon: `brew install Mesh-LLM/tap/mesh-llm`; other platforms: use the \
         documented install script or release bundle), then activate the Mesh LLM engine again."
    )
}

async fn record_version(binary: &str) {
    let version = Command::new(binary)
        .arg("--version")
        .no_window()
        .output()
        .await
        .ok()
        .and_then(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            stdout
                .split_whitespace()
                .chain(stderr.split_whitespace())
                .find(|token| {
                    token
                        .chars()
                        .next()
                        .is_some_and(|character| character.is_ascii_digit())
                })
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "adopted".to_string());
    if let Err(error) = VersionStore::set_version_persisted(VERSION_KEY, &version) {
        tracing::warn!("could not persist Mesh LLM version: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{managed_binary_path, VERSION_KEY};

    #[test]
    fn managed_path_uses_the_chat_engine_directory() {
        assert!(managed_binary_path()
            .parent()
            .unwrap()
            .ends_with("engines/chat/mesh-llm"));
        assert!(
            managed_binary_path().ends_with(if cfg!(target_os = "windows") {
                "mesh-llm.exe"
            } else {
                "mesh-llm"
            })
        );
    }

    #[test]
    fn version_key_is_the_engine_name() {
        assert_eq!(VERSION_KEY, "mesh-llm");
    }
}
