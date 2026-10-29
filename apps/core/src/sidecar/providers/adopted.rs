//! Shared lifecycle for externally managed engines that Ryu only adopts.
//!
//! Lemonade, llama-swap, Magnitude and FreeToken each run their own loopback
//! server. Ryu never spawns or stops them: "start" probes the API and marks the
//! engine adopted, "stop" and "uninstall" only detach, and the health monitor
//! drops the adoption when the probe fails. Each engine supplies its probe and
//! labels through [`AdoptedProbe`]; [`AdoptedEngine`] owns everything else.

use std::future::Future;
use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// The per-engine half of an adopted external engine.
pub trait AdoptedProbe: Send + Sync + 'static {
    /// Sidecar and version-store name.
    const ENGINE: &'static str;
    /// Name used in the HTTP client, detach and not-active messages.
    const LABEL: &'static str;
    /// Name used in the "adopted for local inference" log.
    const ADOPTED_LABEL: &'static str = Self::LABEL;
    /// Default API base the probe joins its paths onto.
    const DEFAULT_BASE: &'static str;
    /// Context attached to a failed probe: how to install and start the engine.
    const SETUP_HINT: &'static str;
    /// Error when the engine cannot run on this node at all.
    const PLATFORM_HINT: &'static str = "";

    /// Whether this node can run the engine at all.
    fn supported() -> bool {
        true
    }

    /// Prove that `base` serves this engine's API.
    fn probe(
        client: &reqwest::Client,
        base: &str,
    ) -> impl Future<Output = anyhow::Result<()>> + Send;
}

pub struct AdoptedEngine<P: AdoptedProbe> {
    pub(super) adopted: Arc<AtomicBool>,
    pub(super) client: reqwest::Client,
    pub(super) base_url: String,
    pub(super) supported: bool,
    _probe: PhantomData<fn() -> P>,
}

impl<P: AdoptedProbe> AdoptedEngine<P> {
    pub fn new() -> Self {
        Self {
            adopted: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_else(|e| panic!("{} HTTP client: {e:?}", P::LABEL)),
            base_url: P::DEFAULT_BASE.to_owned(),
            supported: P::supported(),
            _probe: PhantomData,
        }
    }

    pub async fn ensure_available(&self) -> anyhow::Result<()> {
        anyhow::ensure!(self.supported, P::PLATFORM_HINT);
        P::probe(&self.client, &self.base_url)
            .await
            .context(P::SETUP_HINT)
    }

    pub async fn install(&self) -> anyhow::Result<String> {
        self.ensure_available().await?;
        crate::sidecar::download_manager::VersionStore::set_version_persisted(
            P::ENGINE,
            "adopted",
        )?;
        Ok("adopted".to_owned())
    }
}

impl<P: AdoptedProbe> Default for AdoptedEngine<P> {
    fn default() -> Self {
        Self::new()
    }
}

impl<P: AdoptedProbe> Sidecar for AdoptedEngine<P> {
    fn name(&self) -> &str {
        P::ENGINE
    }
    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let adopted = Arc::clone(&self.adopted);
        let client = self.client.clone();
        let base_url = self.base_url.clone();
        let supported = self.supported;
        Box::pin(async move {
            anyhow::ensure!(supported, P::PLATFORM_HINT);
            let result = P::probe(&client, &base_url).await.context(P::SETUP_HINT);
            adopted.store(result.is_ok(), Ordering::Relaxed);
            result?;
            tracing::info!("{} adopted for local inference", P::ADOPTED_LABEL);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let adopted = Arc::clone(&self.adopted);
        Box::pin(async move {
            adopted.store(false, Ordering::Relaxed);
            tracing::info!(
                "{} detached; externally managed server left running",
                P::LABEL
            );
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let adopted = Arc::clone(&self.adopted);
        let client = self.client.clone();
        let base_url = self.base_url.clone();
        Box::pin(async move {
            // A stopped engine must not be re-adopted by the health monitor.
            if !adopted.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy(format!("{} is not active in Ryu", P::LABEL));
            }
            match P::probe(&client, &base_url).await {
                Ok(()) => HealthStatus::Healthy,
                Err(_) => {
                    adopted.store(false, Ordering::Relaxed);
                    HealthStatus::Unhealthy(P::SETUP_HINT.to_owned())
                }
            }
        })
    }

    fn is_running(&self) -> bool {
        self.adopted.load(Ordering::Relaxed)
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        let adopted = Arc::clone(&self.adopted);
        Box::pin(async move {
            // The engine owns its models and data, so `delete_data` is ignored.
            adopted.store(false, Ordering::Relaxed);
            crate::sidecar::remove_from_version_store(P::ENGINE);
            Ok(())
        })
    }
}
