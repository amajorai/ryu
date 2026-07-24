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

// ── Shadow API token ───────────────────────────────────────────────────────────
//
// Shadow's HTTP surface is bearer-gated (apps/shadow/src/server.rs): everything
// except `/health` requires a shared secret so a hostile local process or web
// page cannot read screen history or flip capture consent. The secret is a
// persisted file under the Shadow data dir; Core reads-or-creates it at spawn
// and presents it from every Shadow client (`sidecar/mcp/shadow`, the external
// `/stop` below).

/// Path of the persisted Shadow API token: `<ryu_dir>/shadow/api-token` — the
/// same file Shadow itself resolves, because [`ShadowProcess::start`] points
/// `SHADOW_DATA_DIR` at `<ryu_dir>/shadow`.
fn api_token_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join("shadow").join("api-token")
}

/// Read-or-create the shared-secret Shadow API token (owner-only permissions),
/// mirroring Shadow's own first-run minting so whichever side starts first wins
/// and the other reads the same value.
pub(crate) fn ensure_api_token() -> anyhow::Result<String> {
    let path = api_token_path();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_owned());
        }
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let dir = path.parent().expect("token path has a parent");
    std::fs::create_dir_all(dir).context("creating shadow data dir")?;
    std::fs::write(&path, &token).context("persisting shadow api token")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

/// Resolve the token Core's Shadow clients present: `SHADOW_API_TOKEN` env
/// (operator override — the spawn env in [`ShadowProcess::start`] honours the
/// same export), else the profile-aware token file, else the standalone default
/// `~/.shadow/api-token` (a dev-started `shadow start` with no `SHADOW_DATA_DIR`
/// mints its token there, and Core adopts such servers). `None` = no token
/// found; Shadow will reject the call (fail closed).
pub fn api_token() -> Option<String> {
    if let Ok(env_token) = std::env::var("SHADOW_API_TOKEN") {
        let trimmed = env_token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    for path in [
        api_token_path(),
        dirs::home_dir()?.join(".shadow").join("api-token"),
    ] {
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

/// Resolve the Shadow base URL: `RYU_SHADOW_URL` if set, else the profile-aware
/// default (`127.0.0.1:3030` on release, `:4030` on dev, …) matching the port the
/// [`ShadowProcess`] spawns on. `profile::apply_env_defaults` also seeds
/// `RYU_SHADOW_URL` under a non-release profile, so this fallback and the env
/// resolve to the same port either way. Used by the `/api/shadow/*` proxy (the
/// bridge the declarative `shadow` plugin tools reach Shadow through).
pub fn base_url() -> String {
    std::env::var("RYU_SHADOW_URL")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{}", crate::profile::port(3030)))
}

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
            // Profile-aware Shadow port (release 3030, dev 4030, …). Every Shadow
            // CLIENT (`server/clips`, `sidecar/mcp/shadow`, `meetings`) dials the
            // same port via the `RYU_SHADOW_URL` env default that
            // `profile::apply_env_defaults` seeds, so spawn and clients agree.
            port: crate::profile::port(3030),
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
                // `/stop` is bearer-gated like every non-health route.
                let url = format!("http://127.0.0.1:{port}/stop");
                let mut request = client.get(&url);
                if let Some(token) = api_token() {
                    request = request.bearer_auth(token);
                }
                if let Err(e) = request.send().await {
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

#[cfg(test)]
mod tests {
    use super::*;

    // Serializes SHADOW_API_TOKEN mutation so the get/restore never races a parallel
    // test that reads the same global (poison-tolerant).
    static SHADOW_TOKEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_token() -> std::sync::MutexGuard<'static, ()> {
        SHADOW_TOKEN_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn api_token_prefers_env_and_trims() {
        // The env branch returns BEFORE any file read, so it is deterministic regardless
        // of whatever token files happen to exist on the host.
        let _lock = lock_token();
        let prev = std::env::var("SHADOW_API_TOKEN").ok();
        std::env::set_var("SHADOW_API_TOKEN", "  secret-bearer  ");
        assert_eq!(api_token().as_deref(), Some("secret-bearer"));
        match prev {
            Some(v) => std::env::set_var("SHADOW_API_TOKEN", v),
            None => std::env::remove_var("SHADOW_API_TOKEN"),
        }
    }

    #[test]
    fn api_token_path_lives_under_ryu_shadow() {
        let p = api_token_path();
        assert!(p.ends_with("api-token"));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "shadow");
    }

    #[test]
    fn health_url_and_port_are_loopback() {
        // Construct with an explicit port (no liveness probe in a sync test → no-op).
        let mgr = ShadowManager::new().with_port(4030);
        assert_eq!(mgr.health_url(), "http://127.0.0.1:4030/health");
        assert_eq!(mgr.name(), "shadow");
        assert!(!mgr.is_required());
    }

    #[tokio::test]
    async fn server_reachable_reflects_a_live_health_endpoint() {
        use axum::routing::get;
        use axum::Router;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/health", get(|| async { "OK" }));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
                .unwrap();
        });

        let client = reqwest::Client::new();
        assert!(ShadowManager::server_reachable(&client, port).await);

        // Kill it → the same port is no longer reachable.
        let _ = tx.send(());
        let _ = server.await;
        assert!(!ShadowManager::server_reachable(&client, port).await);
    }
}
