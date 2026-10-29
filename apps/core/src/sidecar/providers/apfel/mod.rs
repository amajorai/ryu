//! Apple Foundation Models via [apfel](https://github.com/Arthur-Ficial/apfel).
//!
//! apfel is a Swift CLI that exposes Apple's on-device `SystemLanguageModel`
//! (Apple Intelligence) as an **OpenAI-compatible HTTP server** — `apfel --serve`
//! serves `http://127.0.0.1:<port>/v1` and reports a single model,
//! `apple-foundationmodel`. That makes it a drop-in *local engine* for Ryu: the
//! gateway's `local` provider forwards to it exactly like llama.cpp/Ollama, so
//! chat routed to `apple-foundationmodel` runs fully on-device with no API key.
//!
//! Lifecycle mirrors [`crate::sidecar::providers::OllamaManager`] (adopt-a-binary,
//! not download-a-weight): if apfel is already answering on Ryu's apfel port we
//! adopt it; otherwise we PATH-resolve/`brew install` apfel and spawn
//! `apfel --serve --port <port>`.
//! Apple FM is a built-in OS model, so there is never a weight file to fetch or a
//! per-model launch flag to pass — one process serves the one model.
//!
//! Placement (CLAUDE.md §1 Core-vs-Gateway): this is **Core** — it decides *what
//! runs* (which local engine renders a turn). Governance of the resulting model
//! call stays in the Gateway.
//!
//! Port note: apfel's default `:11434` is Ollama's port, and an adopted external
//! Ollama daemon keeps running while apfel is resident — apfel's bind would fail
//! while a TCP check passed, sending "Apple FM" chat to Ollama. Ryu therefore
//! launches apfel on its own profile-aware port ([`apfel_port`], via the
//! documented `--port`/`--host` flags in apfel's `docs/cli-reference.md`) and only
//! adopts a server there that lists [`APPLE_FM_MODEL_ID`] on `/v1/models`.

pub mod installer;

/// The single model id apfel serves (Apple's on-device Foundation Model). apfel
/// validates the request's `model` field against this exact id, so Ryu must send
/// it verbatim — unlike llama.cpp/Ollama, which ignore the field. The gateway
/// router maps this id to the `local` provider; Pi advertises + sends it.
pub const APPLE_FM_MODEL_ID: &str = "apple-foundationmodel";

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use super::readiness;
use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};
use crate::win_process::NoWindow;

/// Canonical (release) loopback port Ryu launches apfel on. Free in the 808x
/// block (8088 = speech processing, 8090 = whisper) and off Ollama's `:11434`.
pub const APFEL_PORT_BASE: u16 = 8089;

/// Profile-aware apfel port (release 8089, dev 9089, …). The spawn side
/// (`--port`) and the client URLs in `active_engine` resolve the same port.
pub fn apfel_port() -> u16 {
    crate::profile::port(APFEL_PORT_BASE)
}

/// Base URL (no `/v1`) apfel serves on once resident.
pub fn base_url() -> String {
    format!("http://127.0.0.1:{}", apfel_port())
}

/// apfel's availability endpoint (reports Apple Intelligence readiness).
fn health_url() -> String {
    format!("{}/health", base_url())
}

/// Flags Ryu owns on the apfel command line that take a value. User-supplied
/// args may not override them (a second `--port` would move apfel off the URL
/// Ryu dials; a token would make Core's unauthenticated readiness probe fail).
const MANAGED_VALUE_FLAGS: &[&str] = &["--port", "--host", "--token"];
/// Bare flags Ryu owns, dropped alone so the next user argument survives.
const MANAGED_BARE_FLAGS: &[&str] = &["--serve", "--permissive", "--token-auto"];

/// Build `apfel --serve` arguments: Ryu's fixed loopback binding, then the
/// saved launch settings (native options, then raw args with any managed flag
/// and its value removed).
fn serve_args(port: u16, launch: &crate::inference::LaunchConfig) -> Vec<String> {
    let mut args = vec![
        "--serve".to_string(),
        "--permissive".to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    args.extend(super::launch_args_with_filtered_raw(
        launch,
        crate::inference::Engine::Apfel,
        MANAGED_VALUE_FLAGS,
        MANAGED_BARE_FLAGS,
    ));
    args
}

/// Whether a `/v1/models` payload is apfel's: it lists the Apple FM model id.
/// An Ollama daemon (or any other server) on the port cannot satisfy this.
fn lists_apple_fm(payload: &serde_json::Value) -> bool {
    super::llamacpp::served_model_ids(payload)
        .iter()
        .any(|id| id == APPLE_FM_MODEL_ID)
}

/// Lifecycle manager for the apfel sidecar (Apple Foundation Models server).
pub struct ApfelManager {
    process: ProcessHandle,
    /// `true` when apfel was already serving before we tried to start it (e.g. a
    /// `brew services start apfel` background service). We don't own that process,
    /// so `stop` leaves it running, but health still reports green.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
}

impl ApfelManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
        }
    }

    /// Returns `true` if apfel itself is already answering on its port: the
    /// health route succeeds AND `/v1/models` lists the Apple FM model.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        let healthy = matches!(
            client.get(health_url()).send().await,
            Ok(resp) if resp.status().is_success()
        );
        if !healthy {
            return false;
        }
        match client.get(format!("{}/v1/models", base_url())).send().await {
            Ok(resp) if resp.status().is_success() => resp
                .json::<serde_json::Value>()
                .await
                .is_ok_and(|payload| lists_apple_fm(&payload)),
            _ => false,
        }
    }
}

impl Default for ApfelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for ApfelManager {
    fn name(&self) -> &'static str {
        "apfel"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            // Node-gate: Apple FM only runs on Apple Silicon macOS 26+. Refuse here
            // (not just at the install route) so the auto-start/swap path can never
            // spawn it on an unsupported node.
            installer::ensure_supported()
                .context("Apple Foundation Models are not supported on this node")?;

            // Our own child is already up: nothing to start. Without this guard the
            // reachability probe below would record our child as an adopted external
            // server, and the next stop() would leave it running.
            if process.is_running() {
                return Ok(());
            }
            // Adopt an apfel already serving on Ryu's apfel port rather than
            // spawning a competitor that would fail to bind it.
            let port = apfel_port();
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!("apfel already running on port {port} — adopting existing server");
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            installer::ensure_installed()
                .await
                .context("installing apfel")?;

            tracing::info!("apfel sidecar starting (apfel --serve --port {port})");
            // `--serve` starts the OpenAI-compat server; `--permissive` relaxes
            // Apple's guardrails so benign agent prompts aren't refused as
            // false-positives. apfel binds loopback only, so no auth token is
            // needed — same posture as llama.cpp/Ollama.
            let launch = super::engine_launch_config("apfel").await;
            let args = serve_args(port, &launch);
            readiness::ensure_port_free("apfel", port).await?;
            process
                .start_path_with_args("apfel", &args)
                .await
                .context("spawning `apfel --serve`")?;

            // Wait up to 60 s for the spawned apfel to answer `/health` and list
            // the Apple FM model. Apple FM is resident on the device, so startup
            // is model warmup, not a download — 60 s is generous headroom.
            let probe = readiness::ReadyProbe {
                engine: "apfel",
                port,
                health_path: Some("/health"),
                expected_model: Some(APPLE_FM_MODEL_ID),
                timeout: std::time::Duration::from_secs(60),
            };
            // apfel's stderr is inherited, so there is no captured tail to report.
            let ready =
                readiness::wait_until_ready(&client, &probe, || process.is_running(), String::new)
                    .await;
            if let Err(error) = ready {
                let _ = process.stop().await;
                return Err(error).context("apfel readiness check failed");
            }

            tracing::info!("apfel sidecar started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            // We never spawned an adopted external server, so we must not kill it.
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("apfel was an adopted external server — leaving it running");
                return Ok(());
            }
            process.stop().await.context("stopping apfel process")?;
            tracing::info!("apfel sidecar stopped");
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
                return HealthStatus::Unhealthy("apfel process not running".into());
            }
            match client.get(health_url()).send().await {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("health endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn uninstall(&self, _delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // apfel is a Homebrew-managed binary; best-effort `brew uninstall`.
            // Apple FM's weights are part of the OS and are never removed here.
            match tokio::process::Command::new("brew")
                .args(["uninstall", "apfel"])
                .no_window()
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("apfel Homebrew formula removed"),
                Ok(s) => tracing::warn!("`brew uninstall apfel` exited with {s}"),
                Err(e) => tracing::warn!("could not run `brew uninstall apfel`: {e}"),
            }
            crate::sidecar::remove_from_version_store("apfel");
            tracing::info!("apfel uninstalled");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn apfel_port_does_not_collide_with_ollama() {
        assert_ne!(apfel_port(), 11434);
        assert_eq!(apfel_port(), crate::profile::port(APFEL_PORT_BASE));
        assert!(base_url().ends_with(&format!(":{}", apfel_port())));
    }

    #[test]
    fn serve_args_pin_loopback_port_and_drop_user_overrides() {
        let extra = vec![
            "--port".to_string(),
            "11434".to_string(),
            "--host=0.0.0.0".to_string(),
            "--serve".to_string(),
            "--cors".to_string(),
        ];
        let launch = crate::inference::LaunchConfig {
            extra_args: extra,
            ..Default::default()
        };
        let args = serve_args(8089, &launch);
        assert_eq!(
            args,
            [
                "--serve",
                "--permissive",
                "--host",
                "127.0.0.1",
                "--port",
                "8089",
                "--cors"
            ]
        );
    }

    #[test]
    fn native_options_precede_raw_args_and_keep_managed_flags_out() {
        let launch = crate::inference::LaunchConfig {
            native: json!({ "apfel_max_concurrent": 8, "apfel_retry": true })
                .as_object()
                .cloned()
                .unwrap(),
            extra_args: ["--permissive", "--cors", "--token", "secret"]
                .map(str::to_owned)
                .to_vec(),
            ..Default::default()
        };
        let args = serve_args(8089, &launch);
        assert_eq!(
            args,
            [
                "--serve",
                "--permissive",
                "--host",
                "127.0.0.1",
                "--port",
                "8089",
                "--max-concurrent",
                "8",
                "--retry",
                "--cors"
            ]
        );
    }

    #[test]
    fn only_a_server_listing_apple_fm_is_apfel() {
        assert!(lists_apple_fm(
            &json!({ "data": [{ "id": "apple-foundationmodel" }] })
        ));
        // An Ollama daemon's OpenAI listing must not be adopted as apfel.
        assert!(!lists_apple_fm(
            &json!({ "data": [{ "id": "llama3:latest" }] })
        ));
        assert!(!lists_apple_fm(&json!({ "models": [] })));
    }
}
