//! mlx-serve as a swappable Ryu local engine.
//!
//! mlx-serve exposes the OpenAI-compatible API Ryu's Gateway already speaks.
//! This manager owns only the native server process and its loopback endpoint;
//! mlx-serve owns model discovery/loading in its own model directory. Ryu does
//! not expose mlx-serve's built-in agent/MCP loop as a second tool-execution
//! authority.

pub mod installer;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use anyhow::Context;

use crate::sidecar::owned_loopback::OwnedLoopbackRelay;
use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

static MANAGED_ENDPOINT: RwLock<Option<std::net::SocketAddr>> = RwLock::new(None);

/// Only Core's retained forwarding listener is an inference destination. The
/// native profile port is never advertised to clients as an identity claim.
pub fn managed_base_url() -> Option<String> {
    MANAGED_ENDPOINT
        .read()
        .ok()?
        .map(|address| format!("http://{address}"))
}

/// Stable catalog and manager id.
pub const ENGINE_NAME: &str = "mlx-serve";
/// mlx-serve's documented release-profile default port.
pub const DEFAULT_PORT: u16 = 11234;
/// Explicit loopback bind; mlx-serve's upstream default has historically been
/// wider than Ryu's local-node boundary, so Core never relies on it.
pub const DEFAULT_HOST: &str = "127.0.0.1";

/// Profile-aware port used by both the child process and Ryu's Gateway URL.
pub fn default_port() -> u16 {
    crate::profile::port(DEFAULT_PORT)
}

fn health_url() -> String {
    format!("http://{DEFAULT_HOST}:{}/health", default_port())
}

fn models_url() -> String {
    format!("http://{DEFAULT_HOST}:{}/v1/models", default_port())
}

fn port_addr() -> String {
    format!("{DEFAULT_HOST}:{}", default_port())
}

fn ensure_native_port_available(port: u16) -> anyhow::Result<()> {
    anyhow::ensure!(
        std::net::TcpListener::bind((DEFAULT_HOST, port)).is_ok(),
        "mlx-serve port is occupied by an unmanaged process; stop that server before starting the managed engine"
    );
    Ok(())
}

/// Ryu's default mlx-serve model store: `<data dir>/models/chat/mlx-serve`.
fn default_model_dir() -> std::path::PathBuf {
    crate::sidecar::download_manager::model_family_dir(
        ryu_sidecar_runtime::layout::Modality::Chat,
        "mlx-serve",
    )
}

/// Model directory handed to mlx-serve: `RYU_MLX_SERVE_MODEL_DIR` when set,
/// otherwise [`default_model_dir`] (created on demand).
fn model_dir() -> String {
    if let Ok(value) = std::env::var("RYU_MLX_SERVE_MODEL_DIR") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    let dir = default_model_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("could not create {}: {e}", dir.display());
    }
    dir.to_string_lossy().into_owned()
}

pub struct MlxServeManager {
    process: ProcessHandle,
    ready: Arc<AtomicBool>,
    relay: Arc<tokio::sync::Mutex<Option<OwnedLoopbackRelay>>>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    client: reqwest::Client,
}

impl MlxServeManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            ready: Arc::new(AtomicBool::new(false)),
            relay: Arc::new(tokio::sync::Mutex::new(None)),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client"),
        }
    }

    /// Check the same local HTTP surface that Core will route to. `/health` is
    /// independent of model loading; `/v1/models` confirms the OpenAI surface
    /// is available even when the runtime has no model loaded yet.
    pub async fn server_reachable(client: &reqwest::Client) -> bool {
        let health_ok = matches!(
            client.get(health_url()).send().await,
            Ok(response) if response.status().is_success()
        );
        health_ok
            && matches!(
                client.get(models_url()).send().await,
                Ok(response) if response.status().is_success()
            )
    }

    async fn wait_until_reachable(
        client: &reqwest::Client,
        process: &ProcessHandle,
    ) -> anyhow::Result<()> {
        tokio::time::timeout(std::time::Duration::from_secs(120), async {
            loop {
                anyhow::ensure!(
                    process.is_running(),
                    "mlx-serve child exited before becoming ready"
                );
                if process.owns_loopback_listener(default_port()).await
                    && Self::server_reachable(client).await
                    && process.owns_loopback_listener(default_port()).await
                {
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        })
        .await
        .context("mlx-serve did not expose owned /health and /v1/models within 120 seconds")?
    }
}

impl Default for MlxServeManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for MlxServeManager {
    fn name(&self) -> &'static str {
        ENGINE_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let ready = Arc::clone(&self.ready);
        let relay = Arc::clone(&self.relay);
        let lifecycle = Arc::clone(&self.lifecycle);
        let client = self.client.clone();
        Box::pin(async move {
            let _lifecycle = lifecycle.lock().await;
            installer::ensure_supported().context("mlx-serve is not supported on this node")?;
            ready.store(false, Ordering::Release);
            // Reserve the advertised destination for Core's lifetime, including
            // failed starts and stops. Cached clients cannot dial a replacement.
            let mut relay = relay.lock().await;
            if relay.is_none() {
                *relay = Some(
                    OwnedLoopbackRelay::bind(process.clone(), default_port(), Arc::clone(&ready))
                        .await?,
                );
            }
            if let Some(relay) = relay.as_ref() {
                *MANAGED_ENDPOINT
                    .write()
                    .map_err(|_| anyhow::anyhow!("mlx-serve endpoint lock poisoned"))? =
                    Some(relay.address());
            }
            if process.is_running() {
                Self::wait_until_reachable(&client, &process).await?;
                ready.store(true, Ordering::Release);
                return Ok(());
            }

            ensure_native_port_available(default_port())?;

            let binary = installer::ensure_installed()
                .await
                .context("installing or resolving mlx-serve")?;
            let port = default_port().to_string();
            let model_dir = model_dir();
            let launch = super::engine_launch_config("mlx-serve").await;
            let mut args = vec![
                "--serve".to_string(),
                "--model-dir".to_string(),
                model_dir.clone(),
                "--host".to_string(),
                DEFAULT_HOST.to_string(),
                "--port".to_string(),
                port.clone(),
            ];
            // Typed context, native options and raw args, all through the same
            // managed-flag filter.
            args.extend(launch_args(&launch));
            tracing::info!(
                binary = %binary,
                %port,
                %model_dir,
                "starting mlx-serve"
            );
            process
                .start_path_with_clean_env(&binary, &args, &[])
                .await
                .context("spawning mlx-serve")?;

            if let Err(error) = Self::wait_until_reachable(&client, &process).await {
                process.stop().await?;
                return Err(error);
            }
            ready.store(true, Ordering::Release);
            tracing::info!("mlx-serve started on {}", port_addr());
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let ready = Arc::clone(&self.ready);
        let lifecycle = Arc::clone(&self.lifecycle);
        Box::pin(async move {
            let _lifecycle = lifecycle.lock().await;
            ready.store(false, Ordering::Release);
            process.stop().await.context("stopping mlx-serve")
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        let ready = Arc::clone(&self.ready);
        let client = self.client.clone();
        Box::pin(async move {
            if !ready.load(Ordering::Acquire)
                || !process.owns_loopback_listener(default_port()).await
            {
                return HealthStatus::Unhealthy("mlx-serve owned listener is unavailable or its process identity could not be verified".to_string());
            }
            if Self::server_reachable(&client).await {
                HealthStatus::Healthy
            } else {
                ready.store(false, Ordering::Release);
                HealthStatus::Unhealthy(format!(
                    "mlx-serve /health or /v1/models is not reachable on {}",
                    port_addr()
                ))
            }
        })
    }

    fn is_running(&self) -> bool {
        self.ready.load(Ordering::Acquire) && self.process.is_running()
    }

    fn has_exited(&self) -> bool {
        self.process.has_exited()
    }

    fn pid(&self) -> Option<u32> {
        self.process.pid()
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // Ryu does not own the Homebrew/release installation. Uninstalling
            // the Ryu entry clears our marker; package removal remains an
            // operator action. With `delete_data`, only Ryu's own default model
            // store goes — never a `RYU_MLX_SERVE_MODEL_DIR` the operator chose.
            crate::sidecar::remove_from_version_store(installer::VERSION_KEY);
            if delete_data {
                crate::sidecar::remove_dir(&default_model_dir()).await;
            }
            tracing::info!(
                "mlx-serve version record cleared; remove the binary via its installer if desired"
            );
            Ok(())
        })
    }
}

/// Flags Core passes or owns that take a value. mlx-serve rejects the
/// `--flag=value` form itself, but it is stripped too.
const MANAGED_VALUE_FLAGS: &[&str] = &[
    "--model-dir",
    "--host",
    "--port",
    "--model",
    "--prompt",
    "--api-key",
    "--api-key-env",
    "--lan-share",
    "--lan-name",
];

/// Bare flags Core owns (serve mode, one-shot modes, auth and LAN sharing).
const MANAGED_BARE_FLAGS: &[&str] = &[
    "--serve",
    "--stream",
    "--version",
    "--help",
    "-h",
    "--api-key-strict",
    "--lan-discover",
];

/// Saved launch settings as arguments after Core's managed prefix: typed
/// context size, native options, then raw args, minus managed flags.
fn launch_args(launch: &crate::inference::LaunchConfig) -> Vec<String> {
    super::launch_args_with_filtered_raw(
        launch,
        crate::inference::Engine::MlxServe,
        MANAGED_VALUE_FLAGS,
        MANAGED_BARE_FLAGS,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_settings_emit_typed_native_and_raw_args_without_managed_flags() {
        let launch = crate::inference::LaunchConfig {
            ctx_size: Some(16384),
            native: serde_json::json!({ "max_concurrent": 4, "no_pld": true })
                .as_object()
                .cloned()
                .unwrap(),
            extra_args: [
                "--serve",
                "--metrics",
                "--port",
                "1",
                "--host=0.0.0.0",
                "--lan-discover",
            ]
            .map(str::to_owned)
            .to_vec(),
            ..Default::default()
        };
        assert_eq!(
            launch_args(&launch),
            vec![
                "--ctx-size",
                "16384",
                "--max-concurrent",
                "4",
                "--no-pld",
                "--metrics"
            ]
        );
    }

    #[test]
    fn occupied_native_port_is_rejected_instead_of_adopted() {
        let listener = std::net::TcpListener::bind((DEFAULT_HOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(ensure_native_port_available(port).is_err());
        drop(listener);
        assert!(ensure_native_port_available(port).is_ok());
    }

    #[test]
    fn default_model_dir_is_inside_the_chat_models_dir() {
        assert!(default_model_dir().ends_with("models/chat/mlx-serve"));
    }

    #[test]
    fn engine_name_and_port_are_stable() {
        assert_eq!(ENGINE_NAME, "mlx-serve");
        assert_eq!(DEFAULT_PORT, 11234);
        assert_eq!(DEFAULT_HOST, "127.0.0.1");
    }

    #[test]
    fn endpoint_helpers_use_profile_aware_loopback_urls() {
        assert!(health_url().starts_with("http://127.0.0.1:"));
        assert!(models_url().ends_with("/v1/models"));
        assert!(port_addr().starts_with("127.0.0.1:"));
    }

    #[test]
    fn manager_starts_stopped_and_is_optional() {
        let manager = MlxServeManager::new();
        assert!(!manager.is_required());
        assert!(!manager.is_running());
    }
}
