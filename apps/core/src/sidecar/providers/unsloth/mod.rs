//! Unsloth fine-tuning sidecar — a Core-managed LoRA/QLoRA training runtime.
//!
//! Like the TTS sidecar (`apps/tts-sidecar`), this is an **external Python
//! runtime Core manages**, not part of the mutually-exclusive chat-engine swap.
//! The runtime is a small FastAPI server (`apps/unsloth-sidecar`) that wraps the
//! Apache-2.0 `unsloth` library (+ TRL `SFTTrainer`) behind one HTTP contract
//! (`/health`, `/finetune`, `/finetune/{id}`, `/finetune/{id}/stream`). We use the
//! library, NOT Unsloth's AGPL-3.0 Studio UI.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): **Core** — it decides *what runs*
//! (a fine-tune job on the local node's GPU). Consumed by the Core
//! `/api/finetune/*` data path (`server::finetune`), which proxies job control
//! and streams progress back to the desktop.
//!
//! Lifecycle mirrors [`super::ryutts::RyuTtsManager`]: adopt an already-running
//! server on the port (e.g. `bun run dev:unsloth`) rather than spawning a
//! competitor; otherwise spawn `python -m ryu_unsloth` from the installed sidecar
//! dir. It is opt-in (NOT in `startup_order`) — training is a heavy, on-demand
//! task, and the torch/CUDA stack is the user's to install.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;
use serde_json::Value;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Loopback port the Unsloth sidecar binds to. Distinct from llama.cpp (8080),
/// embeddings (8081), mlx (8082), sd (8083), mlx-vlm (8084), tts (8085).
pub const UNSLOTH_PORT: u16 = 8086;
const UNSLOTH_ADDR: &str = "127.0.0.1:8086";

/// Base URL the sidecar serves on once resident.
pub fn unsloth_base_url() -> String {
    format!("http://{UNSLOTH_ADDR}")
}

/// Core-managed Hugging Face cache the sidecar downloads base models into. Points
/// the sidecar's `HF_HOME` under `~/.ryu` (Core-owned). Overridable via
/// `RYU_UNSLOTH_HF_HOME`.
pub fn hf_home_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("RYU_UNSLOTH_HF_HOME") {
        return std::path::PathBuf::from(dir);
    }
    crate::paths::ryu_dir().join("models").join("hf")
}

/// Where trained adapters are written. We point the sidecar here so outputs land
/// under `~/.ryu/models` and Core's adapter catalog (Unit 3) can index them.
pub fn output_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("RYU_UNSLOTH_OUTPUT_DIR") {
        return std::path::PathBuf::from(dir);
    }
    crate::paths::ryu_dir().join("models")
}

/// Directory holding the `ryu_unsloth` package. Overridable via `RYU_UNSLOTH_DIR`;
/// defaults to the install location `~/.ryu/unsloth-sidecar`.
fn sidecar_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("RYU_UNSLOTH_DIR") {
        return std::path::PathBuf::from(dir);
    }
    crate::paths::ryu_dir().join("unsloth-sidecar")
}

/// Resolve the Python interpreter to run the sidecar with. Prefers an explicit
/// `RYU_UNSLOTH_PYTHON`, then a venv inside the sidecar dir, then a bare
/// `python3` / `python` on PATH.
fn python_program(dir: &std::path::Path) -> String {
    if let Ok(py) = std::env::var("RYU_UNSLOTH_PYTHON") {
        return py;
    }
    let venv = if cfg!(target_os = "windows") {
        dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        dir.join(".venv").join("bin").join("python")
    };
    if venv.exists() {
        return venv.to_string_lossy().to_string();
    }
    if cfg!(target_os = "windows") {
        "python".to_string()
    } else {
        "python3".to_string()
    }
}

/// Lifecycle manager for the Unsloth fine-tuning sidecar (Python training runtime).
pub struct UnslothManager {
    process: ProcessHandle,
    /// `true` when a sidecar was already running before we tried to start it
    /// (adopted external, e.g. `bun run dev:unsloth`). We don't own it, so `stop`
    /// leaves it alone.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    #[allow(dead_code)]
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl UnslothManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
            downloads: None,
        }
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }

    /// Returns `true` if a sidecar is already answering `/health` on the port.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        client
            .get(format!("{}/health", unsloth_base_url()))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}

impl Default for UnslothManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for UnslothManager {
    fn name(&self) -> &'static str {
        "unsloth"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            // Adopt an already-running sidecar (e.g. `bun run dev:unsloth`).
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!(
                    "unsloth already running on {UNSLOTH_ADDR} — adopting existing server"
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            let dir = sidecar_dir();
            if !dir.exists() {
                anyhow::bail!(
                    "Unsloth sidecar not found at {}. Install it (copy `apps/unsloth-sidecar` \
                     there and `pip install -e \".[train]\"`), set RYU_UNSLOTH_DIR to its path, or \
                     run `bun run dev:unsloth` and Core will adopt it.",
                    dir.display()
                );
            }

            let program = python_program(&dir);
            tracing::info!(
                "unsloth starting ({} -m ryu_unsloth, dir={})",
                program,
                dir.display()
            );

            let hf_home = hf_home_dir();
            let _ = std::fs::create_dir_all(&hf_home);
            let out = output_dir();
            let _ = std::fs::create_dir_all(&out);
            let env: Vec<(String, String)> = vec![
                // Make `ryu_unsloth` importable without depending on the cwd.
                ("PYTHONPATH".into(), dir.to_string_lossy().to_string()),
                ("RYU_UNSLOTH_HOST".into(), "127.0.0.1".into()),
                ("RYU_UNSLOTH_PORT".into(), UNSLOTH_PORT.to_string()),
                ("HF_HOME".into(), hf_home.to_string_lossy().to_string()),
                (
                    "RYU_UNSLOTH_OUTPUT_DIR".into(),
                    out.to_string_lossy().to_string(),
                ),
            ];
            let args: Vec<String> = vec!["-m".into(), "ryu_unsloth".into()];
            process
                .start_path_with_env(&program, &args, &env)
                .await
                .with_context(|| {
                    format!(
                        "spawning the Unsloth sidecar ({program} -m ryu_unsloth). Is Python \
                         installed and the base deps available? See apps/unsloth-sidecar/README.md."
                    )
                })?;

            // Uvicorn binds quickly; the heavy torch import only happens per-job.
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                loop {
                    if tokio::net::TcpStream::connect(UNSLOTH_ADDR).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            })
            .await
            .context("unsloth did not start within 30s")?;

            tracing::info!("unsloth started on {UNSLOTH_ADDR}");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("unsloth was an adopted external server — leaving it running");
                return Ok(());
            }
            process.stop().await.context("stopping unsloth process")?;
            tracing::info!("unsloth stopped");
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            let owned_running = process.is_running();
            if !owned_running && !adopted_external.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("unsloth process not running".into());
            }
            match client
                .get(format!("{}/health", unsloth_base_url()))
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => HealthStatus::Healthy,
                Ok(r) => HealthStatus::Unhealthy(format!("unsloth health returned {}", r.status())),
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn pid(&self) -> Option<u32> {
        // `None` when adopted (no owned child).
        self.process.pid()
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_from_version_store("unsloth");
            if delete_data {
                tracing::info!("unsloth delete_data: leaving the sidecar dir intact");
            }
            tracing::info!("unsloth uninstalled");
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// Proxy helpers — Core's `server::finetune` handlers call these to drive the
// sidecar over HTTP. Kept here (next to the manager) so the base URL never
// drifts from the lifecycle code.
// ---------------------------------------------------------------------------

/// Fetch the sidecar's hardware probe (`GET /health`): `{ ok, can_finetune,
/// backend, gpu, vram_bytes, ... }`. Used by `/api/finetune/capability`.
pub async fn health(client: &reqwest::Client) -> anyhow::Result<Value> {
    let url = format!("{}/health", unsloth_base_url());
    let resp = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("unsloth not reachable at {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("unsloth /health returned {}", resp.status());
    }
    resp.json::<Value>().await.context("parsing /health JSON")
}

/// Start a fine-tune job (`POST /finetune`). Returns the sidecar's JSON
/// (`{ job_id, state }`).
pub async fn start_finetune(client: &reqwest::Client, body: &Value) -> anyhow::Result<Value> {
    let url = format!("{}/finetune", unsloth_base_url());
    let resp = client
        .post(&url)
        .json(body)
        .send()
        .await
        .with_context(|| format!("unsloth not reachable at {url}"))?;
    let status = resp.status();
    let json = resp
        .json::<Value>()
        .await
        .context("parsing /finetune JSON")?;
    if !status.is_success() {
        let err = json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        anyhow::bail!("unsloth /finetune failed ({status}): {err}");
    }
    Ok(json)
}

/// One job snapshot (`GET /finetune/{id}`).
pub async fn get_job(client: &reqwest::Client, job_id: &str) -> anyhow::Result<Value> {
    let url = format!("{}/finetune/{job_id}", unsloth_base_url());
    let resp = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("unsloth not reachable at {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("unsloth /finetune/{job_id} returned {}", resp.status());
    }
    resp.json::<Value>().await.context("parsing job JSON")
}

/// All in-process job snapshots (`GET /finetune`).
pub async fn list_jobs(client: &reqwest::Client) -> anyhow::Result<Value> {
    let url = format!("{}/finetune", unsloth_base_url());
    let resp = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("unsloth not reachable at {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("unsloth /finetune returned {}", resp.status());
    }
    resp.json::<Value>().await.context("parsing jobs JSON")
}

/// Cancel a job (`DELETE /finetune/{id}`).
pub async fn cancel_job(client: &reqwest::Client, job_id: &str) -> anyhow::Result<Value> {
    let url = format!("{}/finetune/{job_id}", unsloth_base_url());
    let resp = client
        .delete(&url)
        .send()
        .await
        .with_context(|| format!("unsloth not reachable at {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("unsloth cancel returned {}", resp.status());
    }
    resp.json::<Value>().await.context("parsing cancel JSON")
}

/// Merge a trained adapter into a GGUF (`POST /finetune/merge`). Returns
/// `{ gguf_path, stem, size_bytes, base_model }`. Long-running — pass a client
/// without a short timeout (Core uses the un-timed `ServerState::client`).
pub async fn merge(client: &reqwest::Client, body: &Value) -> anyhow::Result<Value> {
    let url = format!("{}/finetune/merge", unsloth_base_url());
    let resp = client
        .post(&url)
        .json(body)
        .send()
        .await
        .with_context(|| format!("unsloth not reachable at {url}"))?;
    let status = resp.status();
    let json = resp.json::<Value>().await.context("parsing /merge JSON")?;
    if !status.is_success() {
        let err = json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        anyhow::bail!("unsloth /merge failed ({status}): {err}");
    }
    Ok(json)
}

/// URL of the sidecar's SSE progress stream for a job — Core's handler proxies
/// this byte stream straight through as `text/event-stream`.
pub fn stream_url(job_id: &str) -> String {
    format!("{}/finetune/{job_id}/stream", unsloth_base_url())
}
