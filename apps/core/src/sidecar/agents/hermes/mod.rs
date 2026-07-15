use std::path::PathBuf;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};
use crate::win_process::NoWindow;

pub struct HermesManager {
    process: ProcessHandle,
}

impl HermesManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
        }
    }
}

fn hermes_binary() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        for candidate in [
            home.join(".hermes").join("bin").join("hermes"),
            home.join(".hermes")
                .join("hermes-agent")
                .join(".venv")
                .join("bin")
                .join("hermes"),
            home.join(".local").join("bin").join("hermes"),
        ] {
            if candidate.exists() {
                return candidate;
            }
        }
    }
    PathBuf::from("hermes")
}

async fn ensure_api_server_enabled() -> anyhow::Result<()> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    let env_path = home.join(".hermes").join(".env");
    let content = tokio::fs::read_to_string(&env_path)
        .await
        .unwrap_or_default();
    if content.contains("API_SERVER_ENABLED=true") {
        return Ok(());
    }
    if let Some(parent) = env_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let updated = if content.contains("API_SERVER_ENABLED=") {
        content
            .lines()
            .map(|l| {
                if l.starts_with("API_SERVER_ENABLED=") {
                    "API_SERVER_ENABLED=true"
                } else {
                    l
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        format!("{}\nAPI_SERVER_ENABLED=true\n", content.trim_end())
    };
    tokio::fs::write(&env_path, updated).await?;
    Ok(())
}

impl Sidecar for HermesManager {
    fn name(&self) -> &'static str {
        "hermes"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        Box::pin(async move {
            let binary = hermes_binary();
            let needs_install = if binary == PathBuf::from("hermes") {
                tokio::process::Command::new("hermes")
                    .arg("--version")
                    .no_window()
                    .output()
                    .await
                    .map(|o| !o.status.success())
                    .unwrap_or(true)
            } else {
                !binary.exists()
            };

            if needs_install {
                tracing::info!("hermes: installing Hermes Agent");
                let status = tokio::process::Command::new("bash")
                    .args([
                        "-c",
                        "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup",
                    ])
                    .no_window()
                    .status()
                    .await
                    .map_err(|e| anyhow::anyhow!("install script failed: {e}"))?;
                if !status.success() {
                    anyhow::bail!("Hermes Agent install exited with {status}");
                }
            }

            ensure_api_server_enabled().await?;

            let binary = hermes_binary();
            tracing::info!("hermes: starting gateway on port 8642");
            process.start_with_args(&binary, &["gateway"]).await?;
            tracing::info!("hermes: gateway started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        Box::pin(async move { process.stop().await })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        Box::pin(async move {
            if !process.is_running() {
                return HealthStatus::Unhealthy("hermes gateway not running".into());
            }
            static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
            let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
            match client.get("http://127.0.0.1:8642/health").send().await {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => HealthStatus::Degraded(format!("gateway unhealthy: {}", resp.status())),
                Err(e) => HealthStatus::Degraded(format!("gateway not responding: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running()
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_from_version_store("hermes");
            if delete_data {
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".hermes")).await;
                }
            }
            tracing::info!("hermes: uninstalled");
            Ok(())
        })
    }
}
