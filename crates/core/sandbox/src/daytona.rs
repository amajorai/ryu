//! Daytona-backed remote sandbox implementing the Core [`Sandbox`] trait.
//!
//! Unlike the local backends (wasmtime / docker / microsandbox / opensandbox),
//! Daytona is a *remote* sandbox provider reached over HTTP. There is no local
//! daemon and no CLI: this module talks to the Daytona REST API directly with a
//! minimal client built on the tree's existing `reqwest`. Every knob is env-
//! driven — nothing is hardcoded and no secret is baked in (CLAUDE.md §1).
//!
//! ## Detection
//!
//! [`detect`] is a fast, network-free check that an API token is configured. A
//! remote provider with no credential is unusable, so token-presence is the
//! availability signal (mirroring how the CLI backends probe their binary).
//!
//! ## Lifecycle (mirrors [`super::docker`], HTTP instead of a CLI)
//!
//! - `create_workspace` → `POST {base}/sandbox` sized by the configured
//!   [`SandboxSpec`]; the returned sandbox id is the [`WorkspaceId`].
//! - `exec_in_workspace` → `POST {base}/sandbox/{id}/toolbox/process/execute`.
//! - `destroy_workspace` → `DELETE {base}/sandbox/{id}` (the SIGKILL/stop hook
//!   the heartbeat ticker calls on a `kill_*` budget verdict).
//! - `exec` → create a workspace, run once, destroy it (ephemeral one-shot).
//!
//! ## Metering
//!
//! The billed shape of a run is [`DaytonaSandbox::spec`] (env-configured). The
//! heartbeat ticker (`super::heartbeat`) reads it when it registers a run so the
//! Gateway can price the elapsed second-delta against the Daytona rate table.
//! Core never computes cost itself — it only reports the spec.
//!
//! ## Config
//!
//! | Env var                              | Default                      | Meaning                         |
//! |--------------------------------------|------------------------------|---------------------------------|
//! | `RYU_SANDBOX_DAYTONA_URL`            | `https://app.daytona.io/api` | API base URL (no trailing `/`)  |
//! | `RYU_SANDBOX_DAYTONA_TOKEN`          | (also `DAYTONA_API_KEY`)     | Bearer API token                |
//! | `RYU_SANDBOX_DAYTONA_TARGET`         | (unset)                      | Target region, when required    |
//! | `RYU_SANDBOX_DAYTONA_SNAPSHOT`       | (unset)                      | Snapshot/image to boot          |
//! | `RYU_SANDBOX_DAYTONA_TIMEOUT_SECS`   | `30`                         | Per-request HTTP timeout        |
//! | `RYU_SANDBOX_DAYTONA_VCPU`           | `2`                          | Spec: vCPU count                |
//! | `RYU_SANDBOX_DAYTONA_MEM_GIB`        | `4`                          | Spec: memory GiB                |
//! | `RYU_SANDBOX_DAYTONA_STORAGE_GIB`    | `10`                         | Spec: storage GiB               |
//! | `RYU_SANDBOX_DAYTONA_GPU`            | `none`                       | Spec: GPU class (`h200`, …)     |
//! | `RYU_SANDBOX_DAYTONA_GPU_COUNT`      | `0`                          | Spec: GPU count                 |
//! | `RYU_SANDBOX_DAYTONA_OS`             | `linux`                      | Spec: `linux` / `windows`       |

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::json;

use super::spec::{GpuKind, OsKind, SandboxSpec};
use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::BoxFuture;

// ── Configuration knobs (all swappable, nothing hardcoded) ───────────────────

/// API base URL (no trailing slash). Defaults to Daytona's hosted API.
pub const ENV_DAYTONA_URL: &str = "RYU_SANDBOX_DAYTONA_URL";
/// Primary API token env var.
pub const ENV_DAYTONA_TOKEN: &str = "RYU_SANDBOX_DAYTONA_TOKEN";
/// Alternate API token env var (the name Daytona's own tooling uses).
pub const ENV_DAYTONA_TOKEN_ALT: &str = "DAYTONA_API_KEY";
/// Optional target region.
pub const ENV_DAYTONA_TARGET: &str = "RYU_SANDBOX_DAYTONA_TARGET";
/// Optional snapshot/image to boot the sandbox from.
pub const ENV_DAYTONA_SNAPSHOT: &str = "RYU_SANDBOX_DAYTONA_SNAPSHOT";
/// Per-request HTTP timeout in seconds.
pub const ENV_DAYTONA_TIMEOUT_SECS: &str = "RYU_SANDBOX_DAYTONA_TIMEOUT_SECS";

/// Spec sizing knobs.
pub const ENV_DAYTONA_VCPU: &str = "RYU_SANDBOX_DAYTONA_VCPU";
pub const ENV_DAYTONA_MEM_GIB: &str = "RYU_SANDBOX_DAYTONA_MEM_GIB";
pub const ENV_DAYTONA_STORAGE_GIB: &str = "RYU_SANDBOX_DAYTONA_STORAGE_GIB";
pub const ENV_DAYTONA_GPU: &str = "RYU_SANDBOX_DAYTONA_GPU";
pub const ENV_DAYTONA_GPU_COUNT: &str = "RYU_SANDBOX_DAYTONA_GPU_COUNT";
pub const ENV_DAYTONA_OS: &str = "RYU_SANDBOX_DAYTONA_OS";

const DEFAULT_DAYTONA_URL: &str = "https://app.daytona.io/api";
const DEFAULT_TIMEOUT_SECS: u64 = 30;

fn daytona_base_url() -> String {
    std::env::var(ENV_DAYTONA_URL)
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_DAYTONA_URL.to_owned())
}

/// Resolve the API token from either env var (primary wins), trimmed + non-empty.
fn daytona_token() -> Option<String> {
    std::env::var(ENV_DAYTONA_TOKEN)
        .ok()
        .or_else(|| std::env::var(ENV_DAYTONA_TOKEN_ALT).ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

fn request_timeout() -> Duration {
    let secs = std::env::var(ENV_DAYTONA_TIMEOUT_SECS)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u32>().ok())
        .unwrap_or(default)
}

/// Parse a GPU class from a config string, defaulting to [`GpuKind::None`] on any
/// unknown value (a bad knob never fails a spawn — it just means CPU-only).
fn parse_gpu(value: &str) -> GpuKind {
    match value.trim().to_ascii_lowercase().as_str() {
        "h200" => GpuKind::H200,
        "h100" => GpuKind::H100,
        "rtx_pro_6000" | "rtx-pro-6000" => GpuKind::RtxPro6000,
        "rtx_5090" | "rtx-5090" => GpuKind::Rtx5090,
        "rtx_4090" | "rtx-4090" => GpuKind::Rtx4090,
        _ => GpuKind::None,
    }
}

/// Parse an OS from a config string, defaulting to [`OsKind::Linux`].
fn parse_os(value: &str) -> OsKind {
    match value.trim().to_ascii_lowercase().as_str() {
        "windows" | "win" => OsKind::Windows,
        _ => OsKind::Linux,
    }
}

/// Resolve the billed [`SandboxSpec`] for Daytona runs from the env sizing knobs.
///
/// A GPU count of `0` while a GPU class is selected is normalized to `1`, so the
/// spec that reaches metering is internally consistent with the Gateway's
/// `gpu != None => max(1, gpu_count)` rule.
pub fn configured_spec() -> SandboxSpec {
    let gpu = std::env::var(ENV_DAYTONA_GPU)
        .ok()
        .map(|v| parse_gpu(&v))
        .unwrap_or(GpuKind::None);
    let gpu_count = match gpu {
        GpuKind::None => 0,
        _ => env_u32(ENV_DAYTONA_GPU_COUNT, 1).max(1),
    };
    let os = std::env::var(ENV_DAYTONA_OS)
        .ok()
        .map(|v| parse_os(&v))
        .unwrap_or(OsKind::Linux);
    SandboxSpec {
        vcpu: env_u32(ENV_DAYTONA_VCPU, 2).max(1),
        mem_gib: env_u32(ENV_DAYTONA_MEM_GIB, 4).max(1),
        storage_gib: env_u32(ENV_DAYTONA_STORAGE_GIB, 10),
        gpu,
        gpu_count,
        os,
    }
}

// ── Detection ────────────────────────────────────────────────────────────────

/// Result of the Daytona availability probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectResult {
    /// An API token is configured; the backend is usable.
    Available,
    /// No token configured; the backend cannot reach the provider.
    Unavailable(String),
}

/// Probe whether Daytona is usable on this node.
///
/// Network-free by design: it only checks that an API token is configured. A
/// remote provider with no credential is definitionally unusable, and avoiding a
/// live HTTP round-trip keeps this safe to call from a request handler (the
/// picker's `detect_backend`). NEVER provisions anything.
pub async fn detect() -> DetectResult {
    if daytona_token().is_some() {
        DetectResult::Available
    } else {
        DetectResult::Unavailable(format!(
            "no Daytona API token configured (set {ENV_DAYTONA_TOKEN})"
        ))
    }
}

// ── Minimal Daytona API client ───────────────────────────────────────────────

/// A tiny typed client over the Daytona REST API. Holds only resolved config;
/// construction does no I/O.
struct DaytonaClient {
    base: String,
    token: String,
    target: Option<String>,
    snapshot: Option<String>,
    timeout: Duration,
    http: reqwest::Client,
}

impl DaytonaClient {
    /// Build the client from env config, erroring when no token is configured.
    fn from_env() -> Result<Self> {
        let token = daytona_token().ok_or_else(|| {
            anyhow!("Daytona backend requires an API token ({ENV_DAYTONA_TOKEN})")
        })?;
        Ok(Self {
            base: daytona_base_url(),
            token,
            target: std::env::var(ENV_DAYTONA_TARGET)
                .ok()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()),
            snapshot: std::env::var(ENV_DAYTONA_SNAPSHOT)
                .ok()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty()),
            timeout: request_timeout(),
            http: reqwest::Client::new(),
        })
    }

    /// Create a remote sandbox sized by `spec`, returning its id.
    async fn create(&self, spec: &SandboxSpec, network: bool) -> Result<String> {
        let mut body = json!({
            "cpu": spec.vcpu,
            "memory": spec.mem_gib,
            "disk": spec.storage_gib,
            "gpuCount": spec.gpu_count,
            "os": os_wire(spec.os),
            "public": network,
        });
        if !matches!(spec.gpu, GpuKind::None) {
            body["gpuClass"] = json!(gpu_wire(spec.gpu));
        }
        if let Some(target) = &self.target {
            body["target"] = json!(target);
        }
        if let Some(snapshot) = &self.snapshot {
            body["snapshot"] = json!(snapshot);
        }

        let resp = self
            .http
            .post(format!("{}/sandbox", self.base))
            .bearer_auth(&self.token)
            .timeout(self.timeout)
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow!("daytona create request failed: {e}"))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!("daytona create failed (HTTP {status}): {text}"));
        }
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| anyhow!("daytona create returned unparseable body: {e}"))?;
        // Accept `id` or `sandboxId` for forward-compat with the provider.
        value
            .get("id")
            .or_else(|| value.get("sandboxId"))
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("daytona create response had no sandbox id: {text}"))
    }

    /// Execute a command inside an existing sandbox.
    async fn exec(&self, id: &str, spec: &ExecSpec) -> Result<ExecOutput> {
        // Join argv into a single shell command line; the toolbox executes it.
        let mut command = spec.command.clone();
        for arg in &spec.args {
            command.push(' ');
            command.push_str(arg);
        }
        let mut body = json!({ "command": command });
        if let Some(secs) = spec.timeout_secs {
            body["timeout"] = json!(secs);
        }

        let timeout = spec
            .timeout_secs
            .map(|s| Duration::from_secs(s).max(self.timeout))
            .unwrap_or(self.timeout);

        let resp = self
            .http
            .post(format!(
                "{}/sandbox/{id}/toolbox/process/execute",
                self.base
            ))
            .bearer_auth(&self.token)
            .timeout(timeout)
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow!("daytona exec request failed: {e}"))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!("daytona exec failed (HTTP {status}): {text}"));
        }
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| anyhow!("daytona exec returned unparseable body: {e}"))?;
        let exit_code = value
            .get("exitCode")
            .or_else(|| value.get("code"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0) as i32;
        // The toolbox returns combined output under `result`/`output`/`stdout`.
        let stdout = value
            .get("result")
            .or_else(|| value.get("output"))
            .or_else(|| value.get("stdout"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .as_bytes()
            .to_vec();
        let stderr = value
            .get("stderr")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .as_bytes()
            .to_vec();
        Ok(ExecOutput {
            exit_code,
            stdout,
            stderr,
        })
    }

    /// Destroy a sandbox by id.
    async fn destroy(&self, id: &str) -> Result<()> {
        let resp = self
            .http
            .delete(format!("{}/sandbox/{id}", self.base))
            .bearer_auth(&self.token)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| anyhow!("daytona destroy request failed: {e}"))?;
        let status = resp.status();
        // A 404 means the sandbox is already gone — treat as success (idempotent).
        if status.is_success() || status.as_u16() == 404 {
            return Ok(());
        }
        let text = resp.text().await.unwrap_or_default();
        Err(anyhow!("daytona destroy failed (HTTP {status}): {text}"))
    }
}

/// Wire string for a GPU class in the Daytona create body.
fn gpu_wire(gpu: GpuKind) -> &'static str {
    match gpu {
        GpuKind::None => "none",
        GpuKind::H200 => "h200",
        GpuKind::H100 => "h100",
        GpuKind::RtxPro6000 => "rtx_pro_6000",
        GpuKind::Rtx5090 => "rtx_5090",
        GpuKind::Rtx4090 => "rtx_4090",
    }
}

/// Wire string for the OS in the Daytona create body.
fn os_wire(os: OsKind) -> &'static str {
    match os {
        OsKind::Linux => "linux",
        OsKind::Windows => "windows",
    }
}

// ── DaytonaSandbox ───────────────────────────────────────────────────────────

/// Daytona remote-sandbox backend. Cheap to construct (no I/O); all requests
/// resolve config from env at call time so a key/URL change takes effect on the
/// next call without reconstruction.
#[derive(Clone)]
pub struct DaytonaSandbox;

impl DaytonaSandbox {
    /// Construct the backend. No I/O.
    pub fn new() -> Self {
        Self
    }

    /// The billed [`SandboxSpec`] for runs on this backend, resolved from env.
    /// The heartbeat ticker reads this when registering a run for metering.
    pub fn spec(&self) -> SandboxSpec {
        configured_spec()
    }
}

impl Default for DaytonaSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Sandbox for DaytonaSandbox {
    fn name(&self) -> &'static str {
        "daytona"
    }

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            let client = DaytonaClient::from_env()?;
            let sandbox_spec = configured_spec();
            let network = spec.capabilities.network;
            let id = client.create(&sandbox_spec, network).await?;
            // Always destroy, even when the exec errors — an ephemeral run must
            // not leak a remote (billable) sandbox.
            let result = client.exec(&id, &spec).await;
            if let Err(e) = client.destroy(&id).await {
                tracing::warn!(sandbox_id = %id, error = %e, "daytona: ephemeral cleanup failed");
            }
            result
        })
    }

    fn create_workspace(
        &self,
        capabilities: SandboxCapabilities,
    ) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            let client = DaytonaClient::from_env()?;
            let sandbox_spec = configured_spec();
            let id = client.create(&sandbox_spec, capabilities.network).await?;
            Ok(WorkspaceId(id))
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let sandbox_id = id.0.clone();
        Box::pin(async move {
            let client = DaytonaClient::from_env()?;
            client.exec(&sandbox_id, &spec).await
        })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let sandbox_id = id.0.clone();
        Box::pin(async move {
            let client = DaytonaClient::from_env()?;
            client.destroy(&sandbox_id).await
        })
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes tests that mutate the process-global Daytona env vars.
    static DAYTONA_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        DAYTONA_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn backend_name_is_daytona() {
        assert_eq!(DaytonaSandbox::new().name(), "daytona");
    }

    #[tokio::test]
    async fn detect_reflects_token_presence() {
        let _lock = lock_env();
        unsafe {
            std::env::remove_var(ENV_DAYTONA_TOKEN);
            std::env::remove_var(ENV_DAYTONA_TOKEN_ALT);
        }
        assert!(matches!(detect().await, DetectResult::Unavailable(_)));
        unsafe { std::env::set_var(ENV_DAYTONA_TOKEN, "tok_test") };
        assert_eq!(detect().await, DetectResult::Available);
        unsafe { std::env::remove_var(ENV_DAYTONA_TOKEN) };
    }

    #[test]
    fn gpu_count_normalized_to_one_when_gpu_selected() {
        let _lock = lock_env();
        unsafe {
            std::env::set_var(ENV_DAYTONA_GPU, "h100");
            std::env::remove_var(ENV_DAYTONA_GPU_COUNT);
        }
        let spec = configured_spec();
        assert_eq!(spec.gpu, GpuKind::H100);
        assert_eq!(spec.gpu_count, 1, "a selected GPU must bill at least one");
        unsafe {
            std::env::remove_var(ENV_DAYTONA_GPU);
        }
    }

    #[test]
    fn cpu_only_spec_has_zero_gpu_count() {
        let _lock = lock_env();
        unsafe {
            std::env::remove_var(ENV_DAYTONA_GPU);
            std::env::set_var(ENV_DAYTONA_GPU_COUNT, "4");
        }
        let spec = configured_spec();
        assert_eq!(spec.gpu, GpuKind::None);
        assert_eq!(spec.gpu_count, 0, "no GPU class means zero billable GPUs");
        unsafe { std::env::remove_var(ENV_DAYTONA_GPU_COUNT) };
    }

    #[tokio::test]
    async fn client_from_env_requires_token() {
        let _lock = lock_env();
        unsafe {
            std::env::remove_var(ENV_DAYTONA_TOKEN);
            std::env::remove_var(ENV_DAYTONA_TOKEN_ALT);
        }
        assert!(DaytonaClient::from_env().is_err());
        unsafe { std::env::set_var(ENV_DAYTONA_TOKEN, "tok_test") };
        assert!(DaytonaClient::from_env().is_ok());
        unsafe { std::env::remove_var(ENV_DAYTONA_TOKEN) };
    }
}
