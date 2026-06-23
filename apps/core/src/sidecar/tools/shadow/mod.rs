pub mod downloader;
pub mod process;

pub use downloader::ShadowDownloader;
pub use process::ShadowProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// How often the background liveness probe re-checks Shadow's HTTP port.
const LIVENESS_PROBE_INTERVAL: Duration = Duration::from_secs(5);

/// Lifecycle manager for the Shadow sidecar process.
///
/// Shadow's liveness is reported from **reachability of its HTTP port**, not
/// merely from process ownership. Shadow is opt-in (not in `startup_order`) and
/// is frequently started outside this Core process — by `bun run dev`
/// (`shadow start`), or as an orphan that survives a Core restart
/// (`ShadowProcess` uses `kill_on_drop(false)`). In both cases the managed
/// `child` is `None`, so an ownership-only `is_running()` would report "stopped"
/// while Shadow happily answers on `:3030`. A background probe keeps
/// `external_alive` in sync with the real port so `/api/sidecar/status` — and
/// every client that reads it (desktop Apps page, island, CLI) — tells the truth.
pub struct ShadowManager {
    process: Arc<Mutex<Option<ShadowProcess>>>,
    /// `true` when a Shadow server was already answering on the port when we
    /// tried to start it (adopted external). We did not spawn it, so `stop`
    /// asks it to exit over HTTP rather than killing a process we don't own.
    adopted_external: Arc<AtomicBool>,
    /// Cached reachability of Shadow's HTTP port, refreshed by a background
    /// probe. This is the source of truth for `is_running()` regardless of who
    /// spawned Shadow.
    external_alive: Arc<AtomicBool>,
    /// Ensures the background liveness probe is spawned at most once.
    probe_started: Arc<AtomicBool>,
    client: reqwest::Client,
    port: u16,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl ShadowManager {
    pub fn new() -> Self {
        let manager = Self {
            process: Arc::new(Mutex::new(None)),
            adopted_external: Arc::new(AtomicBool::new(false)),
            external_alive: Arc::new(AtomicBool::new(false)),
            probe_started: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
            port: 3030,
            downloads: None,
        };
        manager.ensure_liveness_probe();
        manager
    }

    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }

    fn health_url(&self) -> String {
        format!("http://127.0.0.1:{}/health", self.port)
    }

    /// Returns `true` if Shadow is answering a successful `/health` on its port.
    async fn server_reachable(client: &reqwest::Client, port: u16) -> bool {
        let url = format!("http://127.0.0.1:{port}/health");
        client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Spawn the background liveness probe once. Requires a Tokio runtime; in
    /// non-async contexts (e.g. unit tests constructing the manager) this is a
    /// no-op and `external_alive` stays `false`, preserving ownership-only
    /// behaviour there.
    fn ensure_liveness_probe(&self) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        if self.probe_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let alive = Arc::clone(&self.external_alive);
        let client = self.client.clone();
        let port = self.port;
        tokio::spawn(async move {
            loop {
                let reachable = Self::server_reachable(&client, port).await;
                alive.store(reachable, Ordering::Relaxed);
                tokio::time::sleep(LIVENESS_PROBE_INTERVAL).await;
            }
        });
    }
}

impl Default for ShadowManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for ShadowManager {
    fn name(&self) -> &'static str {
        "shadow"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        self.ensure_liveness_probe();
        let process = Arc::clone(&self.process);
        let adopted_external = Arc::clone(&self.adopted_external);
        let external_alive = Arc::clone(&self.external_alive);
        let client = self.client.clone();
        let port = self.port;
        let downloads = self.downloads.clone();
        Box::pin(async move {
            // Adopt an already-running Shadow server (e.g. started by `bun run
            // dev`, or an orphan surviving a Core restart) instead of spawning a
            // competing process that would fail to bind the port.
            if Self::server_reachable(&client, port).await {
                adopted_external.store(true, Ordering::Relaxed);
                external_alive.store(true, Ordering::Relaxed);
                tracing::info!(
                    "shadow already running on 127.0.0.1:{port} — adopting existing server"
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            // Download binary if not already installed.
            let downloads = downloads.expect("shadow manager: download center not wired (main.rs)");
            ShadowDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing shadow binary")?;

            // Ensure the shadow working directory exists.
            let shadow_dir = crate::paths::ryu_dir().join("shadow");
            tokio::fs::create_dir_all(&shadow_dir)
                .await
                .context("creating ~/.ryu/shadow")?;

            // Construct and start the process.
            let binary_path = {
                let name = if cfg!(target_os = "windows") {
                    "shadow.exe"
                } else {
                    "shadow"
                };
                crate::paths::ryu_dir().join("bin").join(name)
            };

            tracing::info!("shadow sidecar starting");
            let mut proc = ShadowProcess::new(binary_path, port);
            proc.start().await.context("spawning shadow process")?;
            *process.lock().unwrap() = Some(proc);

            // Wait for the HTTP port to accept connections (timeout 30 s).
            let addr = format!("127.0.0.1:{}", port);
            tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    if tokio::net::TcpStream::connect(&addr).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .context("shadow did not start within 30s")?;

            external_alive.store(true, Ordering::Relaxed);
            tracing::info!("shadow sidecar started on port {}", port);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let adopted_external = Arc::clone(&self.adopted_external);
        let external_alive = Arc::clone(&self.external_alive);
        let client = self.client.clone();
        let port = self.port;
        Box::pin(async move {
            // Take the process out to avoid holding the mutex across awaits.
            let proc = process.lock().unwrap().take();
            if let Some(mut p) = proc {
                // We spawned it — kill the process we own.
                if let Err(e) = p.stop().await {
                    tracing::warn!("shadow stop error: {e}");
                }
            } else if adopted_external.swap(false, Ordering::Relaxed)
                || Self::server_reachable(&client, port).await
            {
                // We don't own the process (adopted, dev-started, or orphaned),
                // but it is answering on the port. Ask it to exit over HTTP via
                // Shadow's `/stop` endpoint rather than killing a stranger PID.
                let url = format!("http://127.0.0.1:{port}/stop");
                if let Err(e) = client.get(&url).send().await {
                    tracing::warn!("shadow external stop request failed: {e}");
                }
            }
            // Reflect the stop immediately; the liveness probe will reconcile.
            external_alive.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let client = self.client.clone();
        let port = self.port;
        Box::pin(async move {
            let url = format!("http://localhost:{}/health", port);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<serde_json::Value>().await {
                        Ok(json)
                            if json.get("status").and_then(|s| s.as_str()) == Some("healthy") =>
                        {
                            HealthStatus::Healthy
                        }
                        Ok(json) => HealthStatus::Degraded(format!(
                            "unexpected health response: {:?}",
                            json
                        )),
                        Err(e) => HealthStatus::Degraded(format!(
                            "failed to parse health response: {}",
                            e
                        )),
                    }
                }
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("health endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        // Lazily ensure the liveness probe is running (covers managers built
        // before a Tokio runtime existed, then queried under one).
        self.ensure_liveness_probe();
        let owned = {
            let mut guard = self.process.lock().unwrap();
            guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
        };
        // Liveness reflects reality: Shadow is "running" if we own a live child
        // OR the port is reachable (dev-started, adopted, or orphaned instance).
        owned || self.external_alive.load(Ordering::Relaxed)
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("shadow").await;
            crate::sidecar::remove_from_version_store("shadow");

            if delete_data {
                // Remove shadow data directory (<data>/shadow/)
                crate::sidecar::remove_dir(&crate::paths::ryu_dir().join("shadow")).await;
            }

            tracing::info!("shadow uninstalled");
            Ok(())
        })
    }
}
