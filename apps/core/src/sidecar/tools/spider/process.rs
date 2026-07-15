//! Spider process management.
//!
//! Spider CLI is primarily a command-line tool for web crawling.
//! Unlike other sidecars, it doesn't run as a persistent server process.
//! The binary is available for on-demand use via CLI commands.

use std::path::PathBuf;
use std::process::Child;

use anyhow::{Context, Result};

use crate::win_process::NoWindow;

pub struct SpiderProcess {
    binary_path: PathBuf,
    child: Option<Child>,
}

impl SpiderProcess {
    pub fn new(binary_path: PathBuf) -> Self {
        Self {
            binary_path,
            child: None,
        }
    }

    /// Start a minimal Spider process to verify it's working.
    /// The actual crawling commands will be run on-demand.
    pub async fn start(&mut self) -> Result<()> {
        // Run `spider --version` to verify the binary works
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
        .context("spawn_blocking for spider version check")??;

        if !output.status.success() {
            anyhow::bail!(
                "spider --version failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        tracing::debug!(
            "spider binary verified: {}",
            String::from_utf8_lossy(&output.stdout).trim()
        );

        // Spider doesn't run as a persistent daemon
        // It's invoked on-demand via CLI commands
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        // Kill any lingering process
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        if let Some(child) = &self.child {
            // Spider is CLI-based, not a persistent process
            // Just check if the binary exists
            self.binary_path.exists()
        } else {
            self.binary_path.exists()
        }
    }
}
