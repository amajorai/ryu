//! llmfit sidecar — hardware-aware LLM model recommendations.
//!
//! llmfit is a terminal tool that recommends LLM models based on your
//! system's RAM, CPU, and GPU. It detects hardware, scores models across
//! quality/speed/fit/context dimensions, and tells you which ones will
//! run well on your machine.

mod downloader;
mod process;

pub use downloader::LlmFitDownloader;
pub use process::LlmFitProcess;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::Mutex;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

pub struct LlmFit {
    process: Arc<Mutex<LlmFitProcess>>,
}

impl LlmFit {
    pub fn new() -> Self {
        let binary_path = Self::binary_path();
        Self {
            process: Arc::new(Mutex::new(LlmFitProcess::new(binary_path))),
        }
    }

    fn binary_path() -> PathBuf {
        let name = if cfg!(target_os = "windows") {
            "llmfit.exe"
        } else {
            "llmfit"
        };
        crate::paths::ryu_dir().join("bin").join(name)
    }
}

impl Sidecar for LlmFit {
    fn name(&self) -> &'static str {
        "llmfit"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<Result<()>> {
        let process = self.process.clone();
        Box::pin(async move {
            let mut p = process.lock().await;
            p.start().await
        })
    }

    fn stop(&self) -> BoxFuture<Result<()>> {
        let process = self.process.clone();
        Box::pin(async move {
            let mut p = process.lock().await;
            p.stop().await
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        Box::pin(async move {
            let p = process.lock().await;
            if p.is_running() {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy("llmfit binary not found".to_string())
            }
        })
    }

    fn is_running(&self) -> bool {
        let binary_path = Self::binary_path();
        binary_path.exists()
    }
}

impl Default for LlmFit {
    fn default() -> Self {
        Self::new()
    }
}
