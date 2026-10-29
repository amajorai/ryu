//! Mesh LLM as a swappable Ryu local engine.
//!
//! Mesh LLM exposes the OpenAI-compatible API Ryu's Gateway already speaks. The
//! manager therefore owns only lifecycle: adopt an already-running endpoint, or
//! start the user's installed `mesh-llm` executable. Routing, approvals, audit,
//! and model selection stay in the existing Gateway/Core seams.

pub mod installer;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Stable catalog and manager id.
pub const ENGINE_NAME: &str = "mesh-llm";
/// Mesh LLM's documented default OpenAI API port.
pub const DEFAULT_PORT: u16 = 9337;

fn models_url() -> String {
    format!(
        "http://127.0.0.1:{}/v1/models",
        crate::profile::port(DEFAULT_PORT)
    )
}

fn port_addr() -> String {
    format!("127.0.0.1:{}", crate::profile::port(DEFAULT_PORT))
}

pub struct MeshLlmManager {
    process: ProcessHandle,
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
}

impl MeshLlmManager {
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

    /// Check the same OpenAI-compatible surface the Gateway will call.
    pub async fn server_reachable(client: &reqwest::Client) -> bool {
        matches!(client.get(models_url()).send().await, Ok(response) if response.status().is_success())
    }
}

impl Default for MeshLlmManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for MeshLlmManager {
    fn name(&self) -> &'static str {
        ENGINE_NAME
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
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!(
                    "Mesh LLM already reachable on {} — adopting existing server",
                    port_addr()
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            let binary = installer::ensure_installed()
                .await
                .context("installing or resolving Mesh LLM")?;
            let port = crate::profile::port(DEFAULT_PORT).to_string();
            let launch = super::engine_launch_config("mesh-llm").await;
            let mut args = vec![
                "serve".to_string(),
                "--headless".to_string(),
                "--port".to_string(),
                port.clone(),
            ];
            // Typed context/parallel/draft, native options, then raw args with
            // Core-owned binding and lifecycle flags removed.
            args.extend(launch_args(&launch));
            let env = super::native_env_for_spawn("mesh-llm", &launch, &[]);
            // Log counts only: invite-token and keystore paths are user data.
            tracing::info!(
                binary = %binary,
                %port,
                args = args.len(),
                env = env.len(),
                "starting Mesh LLM in headless serve mode"
            );
            process
                .start_path_with_env(&binary, &args, &env)
                .await
                .context("spawning Mesh LLM")?;

            tokio::time::timeout(std::time::Duration::from_secs(60), async {
                loop {
                    if Self::server_reachable(&client).await {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            })
            .await
            .context("Mesh LLM did not expose /v1/models within 60 seconds")?;

            tracing::info!("Mesh LLM started on {}", port_addr());
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("Mesh LLM is externally managed — leaving adopted server running");
                return Ok(());
            }
            process.stop().await.context("stopping Mesh LLM")?;
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            if !process.is_running() && !adopted_external.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("Mesh LLM process is not running".to_string());
            }
            if Self::server_reachable(&client).await {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy(format!(
                    "Mesh LLM /v1/models is not reachable on {}",
                    port_addr()
                ))
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn uninstall(&self, _delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            // Ryu does not own Mesh LLM's package-manager installation or
            // ~/.mesh-llm config/model cache. Uninstalling the Ryu engine entry
            // removes only our version marker and adoption state.
            crate::sidecar::remove_from_version_store(ENGINE_NAME);
            adopted_external.store(false, Ordering::Relaxed);
            tracing::info!("Mesh LLM deregistered from Ryu; Mesh LLM files/config untouched");
            Ok(())
        })
    }
}

/// Raw-arg flags Core owns that take a value: the API port and bind address,
/// and the management console port.
const MANAGED_VALUE_FLAGS: &[&str] = &["--port", "--host", "--bind-ip", "--console"];
/// Bare raw-arg tokens Core owns: the serve subcommand and headless mode, plus
/// flags that rebind to every interface, self-update the binary underneath
/// Core, or switch away from serving.
const MANAGED_BARE_FLAGS: &[&str] = &[
    "serve",
    "--headless",
    "--listen-all",
    "--auto-update",
    "--client",
];

/// Saved launch settings as arguments after `serve --headless --port <p>`.
fn launch_args(launch: &crate::inference::LaunchConfig) -> Vec<String> {
    super::launch_args_with_filtered_raw(
        launch,
        crate::inference::Engine::MeshLlm,
        MANAGED_VALUE_FLAGS,
        MANAGED_BARE_FLAGS,
    )
}

#[cfg(test)]
mod tests {
    use super::{launch_args, models_url, DEFAULT_PORT, ENGINE_NAME};

    #[test]
    fn launch_settings_emit_typed_native_then_filtered_raw_args() {
        let launch = crate::inference::LaunchConfig {
            ctx_size: Some(8192),
            native: serde_json::json!({
                "mesh_split": true,
                "mesh_kv_cache_disk": "auto",
                "mesh_name": "serve",
                "mesh_analytics": false,
            })
            .as_object()
            .cloned()
            .unwrap(),
            extra_args: [
                "--listen-all",
                "--port",
                "1",
                "--publish",
                "serve",
                "--console=9",
            ]
            .map(str::to_owned)
            .to_vec(),
            ..Default::default()
        };
        assert_eq!(
            launch_args(&launch),
            vec![
                "--ctx-size",
                "8192",
                "--split",
                "--kv-cache-disk",
                "auto",
                "--mesh-name",
                "serve",
                "--publish"
            ]
        );
        assert_eq!(
            crate::inference::native_env("mesh-llm", &launch.native),
            vec![("MESH_LLM_ANALYTICS".to_owned(), "0".to_owned())]
        );
    }

    #[test]
    fn engine_name_and_default_port_are_stable() {
        assert_eq!(ENGINE_NAME, "mesh-llm");
        assert_eq!(DEFAULT_PORT, 9337);
    }

    #[test]
    fn models_url_is_profile_aware_and_openai_compatible() {
        assert!(models_url().ends_with("/v1/models"));
        assert!(models_url().contains("127.0.0.1:"));
    }
}
