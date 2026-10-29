//! Ghost sidecar — MCP server providing AI eyes and hands for desktop apps.

pub mod downloader;
pub mod process;

pub use downloader::GhostDownloader;
pub use process::GhostProcess;

use std::path::PathBuf;

/// Ghost's state dir: `<data dir>/services/ghost` (pid file, working dir,
/// recipes, snapshots). Exported to Ghost as `GHOST_DATA_DIR`.
pub fn data_dir() -> PathBuf {
    crate::paths::service_dir("ghost")
}

/// Ghost's vision models: `<data dir>/models/vision/ghost`. Exported to Ghost as
/// `GHOST_MODELS_DIR`.
pub fn models_dir() -> PathBuf {
    ryu_sidecar_runtime::layout::model_family_dir(
        &crate::paths::ryu_dir(),
        ryu_sidecar_runtime::layout::Modality::Vision,
        "ghost",
    )
}

/// Absolute path to the installed Ghost binary (`<data dir>/bin/ghost[.exe]`).
///
/// Single source of truth for where the Ghost binary lives, reused by the
/// downloader, the lifecycle manager, and the MCP registry built-in (U14) so
/// the spawn target never drifts between them.
pub fn ghost_bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "ghost.exe"
    } else {
        "ghost"
    };
    crate::paths::bin_dir().join(name)
}

/// Whether `program` (an MCP stdio command after lowering) is the Ghost binary:
/// the managed `ghost_bin_path()` or the `RYU_GHOST_BIN` override Core seeds.
fn is_ghost_program(program: &str) -> bool {
    let program = std::path::Path::new(program.trim());
    if program == ghost_bin_path() {
        return true;
    }
    std::env::var_os("RYU_GHOST_BIN")
        .filter(|value| !value.is_empty())
        .is_some_and(|value| program == std::path::Path::new(&value))
}

/// Seal env for one MCP stdio spawn: Ghost's component subkey
/// (`component_child_env(GHOST)`, never the master key) when `program` is the
/// Ghost binary, nothing for any other server. Core's registry spawns `ghost mcp`
/// per tool call, so every call needs the key to open the sealed snapshot that
/// an earlier call wrote. Without a master key Ghost gets nothing and keeps
/// snapshots in memory only.
pub fn mcp_seal_env_for(program: &str) -> Vec<(String, String)> {
    if !is_ghost_program(program) {
        return Vec::new();
    }
    match ryu_crypto::component_child_env(ryu_crypto::components::GHOST) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!("ghost: no seal key for the MCP child ({error})");
            Vec::new()
        }
    }
}

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Lifecycle manager for the Ghost MCP sidecar process.
pub struct GhostManager {
    running: Arc<std::sync::atomic::AtomicBool>,
    process: Arc<Mutex<Option<GhostProcess>>>,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl GhostManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            downloads: None,
        }
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }
}

impl Default for GhostManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for GhostManager {
    fn name(&self) -> &'static str {
        "ghost"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let downloads = downloads.expect("ghost manager: download center not wired (main.rs)");

            // Download binary if not already installed.
            GhostDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing ghost binary")?;

            // Ensure ghost's working directory exists.
            let ghost_dir = dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".ghost");
            tokio::fs::create_dir_all(&ghost_dir)
                .await
                .context("creating ~/.ghost")?;

            // Construct and start the process.
            let binary_path = ghost_bin_path();

            tracing::info!("ghost sidecar starting");
            let mut proc = GhostProcess::new(binary_path);
            proc.start().await.context("spawning ghost process")?;
            *process.lock().unwrap() = Some(proc);

            running.store(true, Ordering::Relaxed);
            tracing::info!("ghost sidecar started (MCP stdio)");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            let proc = process.lock().unwrap().take();
            if let Some(mut p) = proc {
                if let Err(e) = p.stop().await {
                    tracing::warn!("ghost stop error: {e}");
                }
            }
            running.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        let process = Arc::clone(&self.process);
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("process not running".into());
            }
            let mut guard = process.lock().unwrap();
            if guard.as_mut().map(|p| p.is_running()).unwrap_or(false) {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy("ghost process exited".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        let mut guard = self.process.lock().unwrap();
        guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("ghost").await;
            crate::sidecar::remove_from_version_store("ghost");

            if delete_data {
                crate::sidecar::remove_dir(&data_dir()).await;
                crate::sidecar::remove_dir(&models_dir()).await;
            }

            tracing::info!("ghost uninstalled");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_ghost_binary_gets_the_ghost_subkey() {
        crate::server::gateway_seal_test_key();
        let master = std::env::var("RYU_MASTER_KEY").expect("test master key set");
        let ghost = ghost_bin_path().to_string_lossy().into_owned();
        let env = mcp_seal_env_for(&ghost);
        assert!(env
            .iter()
            .any(|(k, v)| k == "RYU_SEAL_SCOPE" && v == "component:ghost"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "RYU_SEAL_KEY" && !v.is_empty()));
        assert!(
            env.iter().all(|(_, v)| v != &master),
            "never the master key"
        );

        for other in ["npx", "/usr/bin/ghostscript", "", "/bin/sh"] {
            assert!(mcp_seal_env_for(other).is_empty(), "{other:?} got a key");
        }
    }
}
