//! Cloudflared Quick Tunnel lifecycle for the node Tunnel toolkit.

use std::path::PathBuf;

use anyhow::{bail, Result};

use crate::sidecar::cloudflared_downloader;
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

pub const SIDECAR_NAME: &str = "cloudflared";

fn find_on_path() -> Option<PathBuf> {
    let executable = if cfg!(target_os = "windows") {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|directory| directory.join(executable))
        .find(|path| path.is_file())
}

/// Resolve an operator-provided, system-installed, or Ryu-managed executable.
pub fn resolve_binary() -> Result<PathBuf> {
    if let Some(path) = find_on_path() {
        return Ok(path);
    }
    let managed = cloudflared_downloader::managed_path();
    if managed.is_file() {
        return Ok(managed);
    }
    bail!(
        "Cloudflared is not installed. Enable the Quick Tunnel to install the pinned release, or install Cloudflared from the official downloads page: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/"
    )
}

pub(crate) fn scrub_cloudflared_env(inherited: Vec<(String, String)>) -> Vec<(String, String)> {
    crate::sidecar::env_scrub::scrub_child_env(inherited, &[])
}

/// Process manager for the selected public Quick Tunnel.
pub struct CloudflaredManager {
    port: u16,
}

impl CloudflaredManager {
    pub fn new(port: u16) -> Self {
        Self { port }
    }
}

impl Sidecar for CloudflaredManager {
    fn name(&self) -> &'static str {
        SIDECAR_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<Result<()>> {
        let port = self.port;
        Box::pin(async move {
            if port == 0 {
                bail!("Cloudflare Quick Tunnel needs Core to use a fixed HTTP port");
            }
            if !ryu_mesh::is_enabled() {
                bail!("network disabled: enable the Cloudflare Quick Tunnel in the desktop");
            }
            if crate::sidecar::tailscale::mesh_backend().await.0
                != crate::sidecar::tailscale::MeshBackend::Cloudflared
            {
                bail!("Cloudflare Quick Tunnel is not the selected tunnel backend");
            }
            let binary = resolve_binary()?;
            ryu_webhook_ingress::CloudflaredSource::new(port)
                .with_binary(binary)
                .with_env_scrubber(scrub_cloudflared_env)
                .start_for(ryu_webhook_ingress::CloudflaredOwner::TunnelToolkit)
                .await
        })
    }

    fn stop(&self) -> BoxFuture<Result<()>> {
        Box::pin(async {
            ryu_webhook_ingress::CloudflaredSource::stop_for(
                ryu_webhook_ingress::CloudflaredOwner::TunnelToolkit,
            )
            .await
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        Box::pin(async {
            if ryu_webhook_ingress::CloudflaredSource::owned_base_url(
                ryu_webhook_ingress::CloudflaredOwner::TunnelToolkit,
            )
            .is_some()
            {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy("Cloudflare Quick Tunnel is not running".to_owned())
            }
        })
    }

    fn is_running(&self) -> bool {
        ryu_webhook_ingress::CloudflaredSource::owned_base_url(
            ryu_webhook_ingress::CloudflaredOwner::TunnelToolkit,
        )
        .is_some()
    }

    fn has_exited(&self) -> bool {
        false
    }

    fn pid(&self) -> Option<u32> {
        None
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<Result<()>> {
        Box::pin(async {
            ryu_webhook_ingress::CloudflaredSource::stop_for_and_if_last(
                ryu_webhook_ingress::CloudflaredOwner::TunnelToolkit,
                || async {
                    crate::sidecar::remove_ryu_binary(SIDECAR_NAME).await;
                    crate::sidecar::remove_from_version_store(SIDECAR_NAME);
                    tracing::info!("cloudflared: managed Quick Tunnel binary uninstalled");
                    Ok(())
                },
            )
            .await?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_uses_the_cloudflared_sidecar_name() {
        let manager = CloudflaredManager::new(7980);
        assert_eq!(manager.name(), SIDECAR_NAME);
        assert!(!manager.is_required());
    }

    #[test]
    fn cloudflared_environment_keeps_runtime_paths_and_drops_secrets() {
        let env = scrub_cloudflared_env(vec![
            ("PATH".to_owned(), "C:/tools".to_owned()),
            ("HOME".to_owned(), "C:/Users/test".to_owned()),
            ("RYU_TOKEN".to_owned(), "node-secret".to_owned()),
            ("OPENAI_API_KEY".to_owned(), "provider-secret".to_owned()),
        ]);

        assert!(env.contains(&("PATH".to_owned(), "C:/tools".to_owned())));
        assert!(env.contains(&("HOME".to_owned(), "C:/Users/test".to_owned())));
        assert!(!env.iter().any(|(key, _)| key == "RYU_TOKEN"));
        assert!(!env.iter().any(|(key, _)| key == "OPENAI_API_KEY"));
    }
}
