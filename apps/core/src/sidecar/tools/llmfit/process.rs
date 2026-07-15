//! llmfit process management.
//!
//! llmfit is a CLI tool for hardware-aware LLM model recommendations.
//! It does not run as a persistent daemon — it is invoked on-demand.
//! The binary is verified on start and available for CLI use.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::win_process::NoWindow;

pub struct LlmFitProcess {
    binary_path: PathBuf,
}

impl LlmFitProcess {
    pub fn new(binary_path: PathBuf) -> Self {
        Self { binary_path }
    }

    /// Verify the binary works by running `llmfit --version`.
    pub async fn start(&mut self) -> Result<()> {
        let output = tokio::task::spawn_blocking({
            let binary_path = self.binary_path.clone();
            move || {
                std::process::Command::new(&binary_path)
                    .arg("--version")
                    .no_window()
                    .output()
            }
        })
        .await
        .context("spawn_blocking for llmfit version check")??;

        if !output.status.success() {
            anyhow::bail!(
                "llmfit --version failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        tracing::debug!(
            "llmfit binary verified: {}",
            String::from_utf8_lossy(&output.stdout).trim()
        );

        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.binary_path.exists()
    }
}
