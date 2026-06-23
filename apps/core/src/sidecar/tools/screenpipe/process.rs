//! Screenpipe process management.
//!
//! Screenpipe runs via npx and provides screen recording capabilities.

use std::process::Child;

use anyhow::{Context, Result};

pub struct ScreenpipeProcess {
    child: Option<Child>,
}

impl ScreenpipeProcess {
    pub fn new() -> Self {
        Self { child: None }
    }

    /// Start screenpipe via npx.
    pub async fn start(&mut self) -> Result<()> {
        tracing::info!("Starting screenpipe via npx screenpipe@latest record");

        // Run `npx screenpipe@latest record`
        let child = tokio::task::spawn_blocking(move || {
            std::process::Command::new("npx")
                .args(&["screenpipe@latest", "record"])
                .spawn()
        })
        .await
        .context("spawn_blocking for screenpipe")??;

        self.child = Some(child);
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        if let Some(_child) = &self.child {
            // Screenpipe runs via npx, check if the process is alive
            // by checking if npx/screenpipe is accessible
            std::process::Command::new("npx")
                .arg("--version")
                .output()
                .map(|_| true)
                .unwrap_or(false)
        } else {
            false
        }
    }
}
