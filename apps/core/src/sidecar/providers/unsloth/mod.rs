//! Unsloth fine-tuning sidecar — HTTP client helpers.
//!
//! The Unsloth training runtime (a small FastAPI server wrapping the Apache-2.0
//! `unsloth` library + TRL `SFTTrainer`) is no longer a Core-managed sidecar: it is
//! **owned by the `com.ryu.finetune` app** as a manifest-declared managed sidecar
//! (see `packages/finetune-app/plugin.json` + [`crate::sidecar::manifest_sidecar`]),
//! started on plugin-enable + boot-reconcile. Core still owns *what runs* (the job
//! store, GPU gate, adapter→GGUF merge, model registration in `server::finetune`),
//! and reaches the training process over one HTTP contract on a fixed loopback port.
//!
//! This module is just that contract: the base URL + the request helpers
//! (`/health`, `/finetune`, `/finetune/{id}`, `/finetune/{id}/stream`,
//! `/finetune/merge`) that `server::finetune` calls. They are manager-agnostic — they
//! target `127.0.0.1:8086` regardless of who spawned the process — so moving the
//! lifecycle to the app did not touch them. We use the library, NOT Unsloth's
//! AGPL-3.0 Studio UI.

use anyhow::Context;
use serde_json::Value;

/// Loopback port the Unsloth sidecar binds to. Distinct from llama.cpp (8080),
/// embeddings (8081), mlx (8082), sd (8083), mlx-vlm (8084), tts (8085). The
/// `com.ryu.finetune` app's manifest declares this same port.
pub const UNSLOTH_PORT: u16 = 8086;
const UNSLOTH_ADDR: &str = "127.0.0.1:8086";

/// Base URL the sidecar serves on once resident.
pub fn unsloth_base_url() -> String {
    format!("http://{UNSLOTH_ADDR}")
}

// ---------------------------------------------------------------------------
// Proxy helpers — Core's `server::finetune` handlers call these to drive the
// sidecar over HTTP. Kept here (next to the port constant) so the base URL never
// drifts from the contract.
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
