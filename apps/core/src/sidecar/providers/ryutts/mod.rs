//! Ryu TTS sidecar — the universal multi-engine text-to-speech runtime.
//!
//! Like whisper.cpp (`whisper-server`) and stable-diffusion.cpp (`sd-server`),
//! this is an **external runtime Core manages**, not part of the mutually-exclusive
//! chat-engine swap. The difference is the runtime is a small Python FastAPI
//! server (`apps-store/voice/sidecar`) that fronts many TTS engines behind one
//! normalized HTTP contract (`/generate`, `/engines`, `/health`). Adding an engine
//! is a registry row in that app — Core never grows a per-engine branch.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): **Core** — it decides *what runs*
//! (which local TTS engine renders the audio). Consumed by the Core
//! `POST /api/voice/speak?engine=<id>` data path (`server::voice`), which proxies
//! text here and streams back the `audio/wav` the sidecar produces.
//!
//! Lifecycle mirrors [`super::sdcpp::StableDiffusionManager`]: adopt an
//! already-running server on the port (e.g. `bun run dev:tts`) rather than
//! spawning a competing process; otherwise spawn `python -m ryu_tts` from the
//! installed sidecar dir. The heavy per-engine inference deps are the user's to
//! `pip install`; Core surfaces a clear hint when they are missing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;
use serde_json::Value;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};
use crate::win_process::NoWindow;

pub mod kokoro;

/// The default TTS engine id used across every surface when a caller does not
/// specify one. Kokoro 82M — an open-weight (Apache-2.0), CPU-friendly ONNX model
/// served by this sidecar's `kokoro` backend. A swappable default, never a lock:
/// override via `RYU_TTS_ENGINE`. Everything else (voice input STT, OuteTTS, the
/// other sidecar engines) stays reachable via explicit selection.
pub const DEFAULT_TTS_ENGINE: &str = "kokoro";

/// Resolve the default TTS engine id (env-overridable). Callers use this instead of
/// hardcoding an engine so the cross-surface default stays swappable in one place.
pub fn default_tts_engine() -> String {
    std::env::var("RYU_TTS_ENGINE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_TTS_ENGINE.to_string())
}

/// Loopback port the TTS sidecar binds to. Distinct from llama.cpp (8080),
/// embeddings (8081), rerank (8082), classify (8083), mlx-vlm (8084), whisper
/// (8090), and sd (8101).
pub const TTS_PORT: u16 = 8085;
fn tts_address() -> String {
    format!("127.0.0.1:{}", crate::profile::port(TTS_PORT))
}

/// Base URL the sidecar serves on once resident.
pub fn tts_base_url() -> String {
    format!("http://{}", tts_address())
}

/// The shared-secret bearer the TTS sidecar authenticates. Voice is a Core-internal
/// provider (not an ext-proxy manifest sidecar), so Core mints the SAME per-plugin
/// token the ext-proxy scheme uses — deterministic from the node token + the voice
/// plugin id — injects it as `RYU_EXT_TOKEN` at spawn, and presents it on every
/// non-`/health` request. This closes the sidecar's `/generate` + model-install
/// endpoints to arbitrary local processes and cross-origin browser POSTs.
pub fn bearer() -> String {
    crate::sidecar::ext_proxy::ext_token(
        crate::sidecar::ext_proxy::node_token().as_deref(),
        crate::plugins::builtins::VOICE_PLUGIN_ID,
    )
}

/// Core-managed Hugging Face cache the sidecar's engines download models into.
/// We point the sidecar's `HF_HOME` at the data dir's shared `models/hf` so every
/// model's bytes live in the Ryu data dir instead of the user's default
/// `~/.cache/huggingface`, and so Core's catalog can detect installed models.
/// Overridable via `RYU_TTS_HF_HOME`.
pub fn hf_home_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("RYU_TTS_HF_HOME") {
        return std::path::PathBuf::from(dir);
    }
    ryu_sidecar_runtime::layout::hf_home(&crate::paths::ryu_dir())
}

/// Ryu's own install location for the `ryu_tts` runtime (wheel + venv):
/// `<data dir>/engines/audio/ryutts`.
pub fn default_sidecar_dir() -> std::path::PathBuf {
    crate::sidecar::download_manager::engine_dir(
        ryu_sidecar_runtime::layout::EngineGroup::Audio,
        "ryutts",
    )
}

/// Directory holding the `ryu_tts` package. Overridable via `RYU_TTS_DIR`;
/// defaults to [`default_sidecar_dir`].
pub fn sidecar_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("RYU_TTS_DIR") {
        return std::path::PathBuf::from(dir);
    }
    default_sidecar_dir()
}

/// The published `ryu_tts` wheel Core provisions the sidecar from, and the
/// `amajorai/ryu-voice` satellite release that carries it.
///
/// The satellite's release TAG and the wheel's own package VERSION are decoupled
/// and do NOT match: every `ryu-voice` release so far attaches the same
/// `ryu_tts_sidecar-0.1.0` wheel, so `v0.1.2` below is the *release* and `0.1.0`
/// is the *package*. Pinned deliberately rather than `releases/latest/download`:
/// the sha256 is fixed, so a floating URL is guaranteed to fail the moment the
/// satellite ships a new wheel. Bumping this means bumping all three together.
const TTS_SIDECAR_RELEASE_TAG: &str = "v0.1.2";
const TTS_SIDECAR_WHEEL_FILE: &str = "ryu_tts_sidecar-0.1.0-py3-none-any.whl";
const TTS_SIDECAR_WHEEL_SHA256: &str =
    "5b1115a842f4f930e403d0316989ce35af22beea375321c8069e1ee97e0bdfd1";

/// The download URL for [`TTS_SIDECAR_WHEEL_FILE`].
fn tts_sidecar_wheel_url() -> String {
    format!(
        "https://github.com/amajorai/ryu-voice/releases/download/{TTS_SIDECAR_RELEASE_TAG}/{TTS_SIDECAR_WHEEL_FILE}"
    )
}

/// The minimum Python the `ryu_tts` wheel accepts (`requires-python = ">=3.10"`).
const TTS_MIN_PYTHON_MINOR: u32 = 10;

/// Find a Python interpreter new enough to install the sidecar wheel, newest first.
///
/// Two reasons this is not just `bootstrap_python()`:
///
/// 1. **A bare `python3` is routinely too old.** macOS ships `/usr/bin/python3` as
///    Python 3.9 — below the wheel's `>=3.10` floor — while a perfectly good
///    `python3.13` sits next to it from Homebrew. Handing pip the 3.9 would fail
///    with "requires a different Python", provisioning would report an error, and
///    TTS would silently stay on OuteTTS on a machine fully capable of running
///    Kokoro. Probing versioned names first is what makes the default work on a
///    stock Mac.
/// 2. **Presence is not usability.** That same `/usr/bin/python3` is a stub that
///    pops the Xcode Command Line Tools installer when invoked without CLT present,
///    so a PATH lookup proves nothing. Every candidate is therefore *run*; only an
///    interpreter that prints its own version is offered.
///
/// Returns `None` when nothing suitable exists, which is a skip (fall back to
/// OuteTTS), not an error.
async fn resolve_python() -> Option<String> {
    // Newest first so a node with several installed gets the best one, then the
    // generic names last as the catch-all (Windows has no `pythonX.Y` shims).
    let mut candidates: Vec<String> = (TTS_MIN_PYTHON_MINOR..=14)
        .rev()
        .map(|m| format!("python3.{m}"))
        .collect();
    candidates.push(crate::sidecar::external_runtime::bootstrap_python().to_owned());

    for candidate in candidates {
        let Ok(out) = tokio::process::Command::new(&candidate)
            .args(["-c", "import sys; print(sys.version_info[1])"])
            .no_window()
            .output()
            .await
        else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let minor: u32 = match String::from_utf8_lossy(&out.stdout).trim().parse() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if minor >= TTS_MIN_PYTHON_MINOR {
            return Some(candidate);
        }
    }
    None
}

/// Best-effort: ensure the sidecar's Python venv exists with the `kokoro` extra
/// installed, so the default Kokoro engine can actually run.
///
/// Returns `Ok(true)` when the sidecar is provisioned (a venv is present after the
/// call), `Ok(false)` when it cannot be provisioned on this node — no usable Python
/// — in which case TTS degrades to the always-available OuteTTS engine. Errors
/// surface a real provisioning failure (venv/pip). Idempotent: an existing venv is
/// reused, so this is a cheap no-op on every boot after the first.
///
/// **Where the code comes from.** This used to bail with `Ok(false)` whenever
/// the sidecar dir did not exist — which was *always*, on every real install:
/// nothing has ever created that directory. The `ryu_tts` package lives at
/// `apps-store/voice/sidecar`, reachable only from a repo checkout via
/// `bun run dev:tts`, and the voice manifest declares no runnable, so the generic
/// manifest-sidecar loader never shipped it either. Net effect: Kokoro's ~330 MB of
/// ONNX weights downloaded on every install and were never once served, `ryutts`
/// never reported installed, and `POST /api/voice/speak` silently fell through to
/// OuteTTS while `DEFAULT_TTS_ENGINE` claimed `kokoro`.
///
/// The fix is not to vendor the app into Core (it is an apps-store satellite; see
/// AGENTS.md) but to install the wheel that satellite already publishes. The
/// `amajorai/ryu-voice` release workflow has been building a wheel + sdist all
/// along — Core simply never pointed at one. We fetch it through the
/// [`crate::downloads::DownloadCenter`] so the transfer is checksum-verified and
/// visible in the download overlay, then hand pip the local path plus the extra.
///
/// A repo checkout (or a hand-copied tree) that already has a `pyproject.toml` at
/// `dir` still takes the editable path, so `RYU_TTS_DIR` pointing at
/// `apps-store/voice/sidecar` keeps working for development.
pub async fn ensure_kokoro_runtime() -> anyhow::Result<bool> {
    use crate::sidecar::external_runtime::{self, ExternalRuntimeConfig};

    let dir = sidecar_dir();
    if external_runtime::venv_exists(&dir) {
        return Ok(true);
    }
    let Some(python) = resolve_python().await else {
        tracing::info!(
            "no Python >= 3.{TTS_MIN_PYTHON_MINOR} on this node — skipping Kokoro Audio \
             provisioning; spoken output uses the built-in OuteTTS engine"
        );
        return Ok(false);
    };

    let downloads = crate::downloads::DownloadCenter::with_default_client();

    // A source tree already at `dir` (dev checkout via RYU_TTS_DIR, or a manual
    // copy) installs editable from it; otherwise install the published wheel.
    let requirements = if dir.join("pyproject.toml").exists() {
        Vec::new()
    } else {
        let wheel = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                role: crate::downloads::DownloadRole::Engine,
                label: "Ryu Audio sidecar".to_string(),
                url: tts_sidecar_wheel_url(),
                dest: dir.join("dist").join(TTS_SIDECAR_WHEEL_FILE),
                sha256: Some(TTS_SIDECAR_WHEEL_SHA256.to_string()),
                version_record: None,
            })
            .await
            .context("downloading the Ryu Audio sidecar wheel")?;
        // `pip install "<path>.whl[kokoro]"` — PEP 508 extras apply to a local
        // wheel exactly as they do to a named requirement, so this pulls
        // kokoro-onnx + onnxruntime + soundfile alongside the sidecar itself.
        vec![format!("{}[kokoro]", wheel.display())]
    };
    // Create the venv HERE with the interpreter we vetted, rather than letting
    // `provision` bootstrap one. `provision` uses the generic `bootstrap_python()`
    // (`python3`), which on macOS is the 3.9 that cannot install this wheel; it
    // skips venv creation when one already exists, so seeding it with the right
    // interpreter is the whole handoff. Everything after — pip, the extras — then
    // runs against a Python the wheel accepts.
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("creating the Audio sidecar dir at {}", dir.display()))?;
    let venv = dir.join(".venv");
    let out = tokio::process::Command::new(&python)
        .arg("-m")
        .arg("venv")
        .arg(&venv)
        .no_window()
        .output()
        .await
        .with_context(|| format!("spawning `{python} -m venv`"))?;
    if !out.status.success() {
        anyhow::bail!(
            "`{python} -m venv {}` failed: {}",
            venv.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }

    let cfg = ExternalRuntimeConfig {
        kind: external_runtime::RUNTIME_PYTHON.to_owned(),
        entry: "ryu_tts".to_owned(),
        pyproject_extra: requirements.is_empty().then(|| "kokoro".to_owned()),
        requirements,
        ..Default::default()
    };
    match external_runtime::provision(&cfg, &dir, &downloads).await {
        Ok(_) => Ok(true),
        Err(e) => {
            // Tear the venv back down. It exists but has no `ryu_tts` in it, and
            // `venv_exists` is this function's "already provisioned" fast path — so
            // leaving it would make every later boot return `Ok(true)`, mark `ryutts`
            // installed, and then fail to start, with no path back except the user
            // deleting the directory by hand. Removing it keeps the failure
            // retryable on the next boot.
            let _ = tokio::fs::remove_dir_all(&venv).await;
            Err(anyhow::anyhow!(
                "provisioning the Kokoro Audio runtime failed: {e}"
            ))
        }
    }
}

/// Resolve the Python interpreter to run the sidecar with. Prefers an explicit
/// `RYU_TTS_PYTHON`, then a venv inside the sidecar dir, then a bare `python3` /
/// `python` on PATH.
fn python_program(dir: &std::path::Path) -> String {
    if let Ok(py) = std::env::var("RYU_TTS_PYTHON") {
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

/// Lifecycle manager for the Ryu TTS sidecar (Python multi-engine runtime).
pub struct RyuTtsManager {
    process: ProcessHandle,
    /// `true` when a sidecar was already running before we tried to start it
    /// (adopted external, e.g. `bun run dev:tts`). We don't own it, so `stop`
    /// leaves it alone.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl RyuTtsManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
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
            .get(format!("{}/health", tts_base_url()))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}

impl Default for RyuTtsManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for RyuTtsManager {
    fn name(&self) -> &'static str {
        "ryutts"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            // Our own child is already up: nothing to start. Without this guard the
            // reachability probe below would record our child as an adopted external
            // server, and the next stop() would leave it running.
            if process.is_running() {
                return Ok(());
            }
            // Adopt an already-running sidecar (e.g. `bun run dev:tts`) instead of
            // spawning a competitor that would fail to bind the port.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!(
                    address = %tts_address(), "Ryu Audio sidecar already running — adopting existing server"
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            let dir = sidecar_dir();
            if !dir.exists() {
                anyhow::bail!(
                    "Ryu Audio sidecar not found at {}. Onboarding provisions it there from the \
                     published wheel when a usable `python3` is present — check the boot log for \
                     a provisioning warning. Otherwise point RYU_TTS_DIR at a checkout of \
                     `apps-store/voice/sidecar`, or run `bun run dev:tts` and Core will adopt it.",
                    dir.display()
                );
            }

            let program = python_program(&dir);
            tracing::info!(
                "Ryu Audio sidecar starting ({} -m ryu_tts, dir={})",
                program,
                dir.display()
            );

            // Point HF model downloads at a Core-managed cache (so bytes live
            // under ~/.ryu and Core can detect installed models). Best-effort dir
            // create — huggingface_hub also creates it on first use.
            let hf_home = hf_home_dir();
            let _ = std::fs::create_dir_all(&hf_home);
            let core_env: Vec<(String, String)> = vec![
                // Make `ryu_tts` importable without depending on the cwd.
                ("PYTHONPATH".into(), dir.to_string_lossy().to_string()),
                ("RYU_TTS_HOST".into(), "127.0.0.1".into()),
                (
                    "RYU_TTS_PORT".into(),
                    crate::profile::port(TTS_PORT).to_string(),
                ),
                // Shared-secret the sidecar fail-closed-checks on every non-/health
                // route; Core presents the same value via `bearer()`.
                (crate::sidecar::ext_proxy::ENV_EXT_TOKEN.into(), bearer()),
                ("HF_HOME".into(), hf_home.to_string_lossy().to_string()),
                // Point the default `kokoro` backend at the model artifacts Core
                // downloads during onboarding (the engine only serves them).
                (
                    "RYU_KOKORO_MODEL".into(),
                    kokoro::model_path().to_string_lossy().to_string(),
                ),
                (
                    "RYU_KOKORO_VOICES".into(),
                    kokoro::voices_path().to_string_lossy().to_string(),
                ),
            ];
            // Saved engine launch settings are environment only: the sidecar has
            // no command line, so raw args are never forwarded.
            let launch = super::engine_launch_config("ryutts").await;
            let env = spawn_env(core_env, &launch);
            let args: Vec<String> = vec!["-m".into(), "ryu_tts".into()];
            process
                .start_path_with_env(&program, &args, &env)
                .await
                .with_context(|| {
                    format!(
                        "spawning the Ryu Audio sidecar ({program} -m ryu_tts). Is Python installed \
                         and the base deps available? See apps-store/voice/sidecar/README.md."
                    )
                })?;

            // Uvicorn binds quickly, but the first import can take a moment.
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                loop {
                    if tokio::net::TcpStream::connect(tts_address()).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            })
            .await
            .context("Ryu Audio sidecar did not start within 30s")?;

            tracing::info!(address = %tts_address(), "Ryu Audio sidecar started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!(
                    "Ryu Audio sidecar was an adopted external server — leaving it running"
                );
                return Ok(());
            }
            process.stop().await.context("stopping Ryu Audio sidecar")?;
            tracing::info!("Ryu Audio sidecar stopped");
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
                return HealthStatus::Unhealthy("Ryu Audio sidecar process not running".into());
            }
            match client
                .get(format!("{}/health", tts_base_url()))
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => HealthStatus::Healthy,
                Ok(r) => HealthStatus::Unhealthy(format!(
                    "Ryu Audio sidecar health returned {}",
                    r.status()
                )),
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn pid(&self) -> Option<u32> {
        // `None` when adopted (no owned child). Note: the TTS sidecar is a Python
        // parent that may fork model workers, so this samples the parent only.
        self.process.pid()
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_from_version_store("ryutts");
            if delete_data {
                // Ryu-owned dirs only: the runtime's venv (unless the operator
                // pointed `RYU_TTS_DIR` elsewhere) and the Kokoro weights. The
                // shared `models/hf` cache is used by other runtimes and stays.
                if std::env::var_os("RYU_TTS_DIR").is_none() {
                    crate::sidecar::remove_dir(&default_sidecar_dir()).await;
                }
                crate::sidecar::remove_dir(&kokoro::models_dir()).await;
            }
            tracing::info!("ryutts uninstalled");
            Ok(())
        })
    }
}

/// Fetch the sidecar's engine catalog (`GET /engines`) so Core can mirror it for
/// the desktop picker. Returns the raw JSON array the sidecar serves.
pub async fn list_engines(client: &reqwest::Client) -> anyhow::Result<Value> {
    let url = format!("{}/engines", tts_base_url());
    let resp = client
        .get(&url)
        .bearer_auth(bearer())
        .send()
        .await
        .with_context(|| format!("Ryu Audio sidecar not reachable at {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("Ryu Audio sidecar /engines returned {}", resp.status());
    }
    resp.json::<Value>().await.context("parsing /engines JSON")
}

/// Fetch the sidecar's curated, installable Audio model catalog (`GET /models`).
/// Each row is a known-good model variant bound to its engine + cache state.
pub async fn list_models(client: &reqwest::Client) -> anyhow::Result<Value> {
    let url = format!("{}/models", tts_base_url());
    let resp = client
        .get(&url)
        .bearer_auth(bearer())
        .send()
        .await
        .with_context(|| format!("Ryu Audio sidecar not reachable at {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("Ryu Audio sidecar /models returned {}", resp.status());
    }
    resp.json::<Value>().await.context("parsing /models JSON")
}

/// Install (download) a curated model via the sidecar's `POST /models/install`,
/// which runs `huggingface_hub.snapshot_download` into the Core-managed HF cache
/// (`HF_HOME`). Returns the sidecar's JSON result. Idempotent (cache hit = fast).
pub async fn install_model(
    client: &reqwest::Client,
    engine: &str,
    model_name: &str,
) -> anyhow::Result<Value> {
    let url = format!("{}/models/install", tts_base_url());
    let resp = client
        .post(&url)
        .bearer_auth(bearer())
        .json(&serde_json::json!({ "engine": engine, "model_name": model_name }))
        .send()
        .await
        .with_context(|| format!("Ryu Audio sidecar not reachable at {url}"))?;
    let status = resp.status();
    let body = resp
        .json::<Value>()
        .await
        .context("parsing /models/install JSON")?;
    if !status.is_success() {
        let err = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        anyhow::bail!("Ryu Audio model install failed ({status}): {err}");
    }
    Ok(body)
}

/// Environment Core sets for the sidecar (plus the Hugging Face token, which
/// stays out of plain launch preferences). Saved options cannot override them.
const MANAGED_ENV: &[&str] = &[
    "PYTHONPATH",
    "RYU_TTS_HOST",
    "RYU_TTS_PORT",
    crate::sidecar::ext_proxy::ENV_EXT_TOKEN,
    "HF_HOME",
    "HF_TOKEN",
    "RYU_KOKORO_MODEL",
    "RYU_KOKORO_VOICES",
];

/// Saved native environment first (minus managed names and anything already in
/// Core's environment), then Core's own variables, which win when applied in
/// order.
fn spawn_env(
    core_env: Vec<(String, String)>,
    launch: &crate::inference::LaunchConfig,
) -> Vec<(String, String)> {
    let mut env = super::native_env_for_spawn("ryutts", launch, MANAGED_ENV);
    env.extend(core_env);
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_environment_precedes_and_never_replaces_core_variables() {
        let launch = crate::inference::LaunchConfig {
            native: serde_json::json!({ "hf_hub_disable_telemetry": true })
                .as_object()
                .cloned()
                .unwrap(),
            extra_args: vec!["--ignored".to_owned()],
            ..Default::default()
        };
        let core = vec![("HF_HOME".to_owned(), "/ryu/models/hf".to_owned())];
        let env = spawn_env(core, &launch);
        assert_eq!(
            env.last(),
            Some(&("HF_HOME".to_owned(), "/ryu/models/hf".to_owned()))
        );
        assert!(!env.iter().any(|(name, _)| name == "--ignored"));
        if std::env::var_os("HF_HUB_DISABLE_TELEMETRY").is_none() {
            assert_eq!(
                env[0],
                ("HF_HUB_DISABLE_TELEMETRY".to_owned(), "1".to_owned())
            );
        }
        for name in MANAGED_ENV {
            assert!(!crate::inference::native_options("ryutts")
                .iter()
                .any(|o| o.target == crate::inference::NativeTarget::Env(name)));
        }
    }
}
