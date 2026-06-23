//! Local headroom compression-proxy lifecycle (M2 / #425).
//!
//! Headroom (`chopratejas/headroom`) is a context-compression engine. Run as a
//! proxy it exposes a `/v1/compress` endpoint that shrinks request messages
//! (60–95% fewer tokens). Core manages it as an *optional* local process and,
//! when enabled, tells the gateway to call it on every model call (the egress
//! transform that auto-wraps every gateway-routed agent — see
//! `apps/gateway/src/compression.rs`).
//!
//! Core-vs-Gateway split: Core decides *what runs* (spawn/enable this process);
//! the Gateway owns the *transform on egress* (what is shared with the
//! provider). Core never compresses inline — it only points the gateway here.
//!
//! Opt-in: compression changes what is sent to the model, so it is **off by
//! default**. Set `RYU_HEADROOM_ENABLED=1` to turn it on. Requires the headroom
//! CLI on `PATH` (`pipx install "headroom-ai[proxy]"`). Everything fails open:
//! if headroom is absent or unhealthy the gateway leaves messages untouched, so
//! chat is never broken by enabling this.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use crate::sidecar::process::ProcessHandle;

/// Default address the headroom proxy binds to and the gateway compresses against.
pub const DEFAULT_HEADROOM_URL: &str = "http://127.0.0.1:8787";

/// Plugin id of the built-in Headroom compression plugin. The plugin's
/// enabled state in the `PluginStore` is the single source of truth for whether
/// compression is active (set into [`set_enabled`] at startup and on
/// enable/disable); `RYU_HEADROOM_ENABLED` is only the dev seed default.
pub const HEADROOM_PLUGIN_ID: &str = "io.ryu.headroom";

/// Env var: master switch for context compression. Default off (opt-in).
const ENV_HEADROOM_ENABLED: &str = "RYU_HEADROOM_ENABLED";
/// Env var: headroom proxy base URL (no trailing `/v1`).
const ENV_HEADROOM_URL: &str = "RYU_HEADROOM_URL";
/// Env var: disable Core spawning/managing headroom (assume external).
const ENV_HEADROOM_MANAGED: &str = "RYU_HEADROOM_MANAGED";
/// Env var: override the headroom binary (otherwise resolved on PATH).
const ENV_HEADROOM_BIN: &str = "RYU_HEADROOM_BIN";
/// Default headroom binary name (resolved via PATH, including `~/.ryu/bin`).
const DEFAULT_HEADROOM_BIN: &str = "headroom";

/// Process-global "compression active" flag — the live switch the gateway
/// spawn-env (`gateway_spawn_env`) and [`HeadroomManager::start`] read. Lazily
/// seeded from `RYU_HEADROOM_ENABLED` on first access so a dev env var still
/// turns it on out of the box; thereafter the headroom plugin's enabled state
/// owns it ([`set_enabled`], called at startup from the `PluginStore` and on
/// plugin enable/disable). One source of truth, so a gateway restart can never
/// silently revert what the plugin set.
static COMPRESSION_ENABLED: OnceLock<AtomicBool> = OnceLock::new();

fn env_seed() -> bool {
    matches!(
        std::env::var(ENV_HEADROOM_ENABLED)
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref(),
        Ok("1" | "true" | "yes" | "on")
    )
}

fn flag() -> &'static AtomicBool {
    COMPRESSION_ENABLED.get_or_init(|| AtomicBool::new(env_seed()))
}

/// Whether context compression is currently active. Driven by the headroom
/// plugin (see [`set_enabled`]); defaults to the `RYU_HEADROOM_ENABLED` seed.
pub fn is_enabled() -> bool {
    flag().load(Ordering::Relaxed)
}

/// Set whether compression is active. Called at startup from the headroom
/// plugin's persisted enabled state, and on plugin enable/disable. The caller is
/// responsible for refreshing the gateway (so `gateway_spawn_env` re-reads this)
/// and starting/stopping the proxy.
pub fn set_enabled(active: bool) {
    flag().store(active, Ordering::Relaxed);
}

/// Base URL of the headroom proxy. Always non-empty.
pub fn headroom_url() -> String {
    std::env::var(ENV_HEADROOM_URL)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_HEADROOM_URL.to_owned())
}

/// Whether Core should spawn and manage the headroom process itself. Defaults
/// to `true`; set `RYU_HEADROOM_MANAGED=0` to point Core at an already-running
/// headroom proxy instead.
fn is_managed() -> bool {
    match std::env::var(ENV_HEADROOM_MANAGED) {
        Ok(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no"),
        Err(_) => true,
    }
}

/// Derive `host:port` from the configured URL for the `--host`/`--port` flags.
fn host_port_from_url() -> (String, u16) {
    let url = headroom_url();
    let stripped = url
        .trim_end_matches('/')
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    match stripped.split_once(':') {
        Some((host, port)) => (host.to_owned(), port.parse().unwrap_or(8787)),
        None => (stripped.to_owned(), 8787),
    }
}

/// Manages the local headroom proxy child process.
pub struct HeadroomManager {
    handle: ProcessHandle,
}

impl HeadroomManager {
    pub fn new() -> Self {
        Self {
            handle: ProcessHandle::new(),
        }
    }

    /// Spawn the headroom proxy (when enabled and not externally managed) and
    /// wait briefly for health. Returns `Ok(true)` when a healthy proxy is
    /// reachable, `Ok(false)` when compression is disabled, externally managed,
    /// or the binary is absent (graceful — the gateway fails open either way).
    pub async fn start(&self) -> anyhow::Result<bool> {
        if !is_enabled() {
            tracing::debug!(
                "headroom: compression disabled (set RYU_HEADROOM_ENABLED=1 to enable)"
            );
            return Ok(false);
        }
        if !is_managed() {
            tracing::info!(url = %headroom_url(), "headroom: externally managed, not spawning");
            return Ok(health_check(&headroom_url()).await);
        }
        if health_check(&headroom_url()).await {
            tracing::info!(url = %headroom_url(), "headroom: already running, reusing");
            return Ok(true);
        }

        let bin = std::env::var(ENV_HEADROOM_BIN)
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_HEADROOM_BIN.to_owned());
        let (host, port) = host_port_from_url();
        tracing::info!(bin = %bin, host = %host, port, "headroom: spawning compression proxy");

        // Inherit Core's environment so provider credentials flow to headroom
        // (the proxy may need them to boot). The gateway only uses the
        // compression-only `/v1/compress` path, which does not forward upstream.
        let args = [
            "proxy".to_owned(),
            "--host".to_owned(),
            host,
            "--port".to_owned(),
            port.to_string(),
        ];
        if let Err(e) = self.handle.start_path_with_env(&bin, &args, &[]).await {
            // Absent binary / failed spawn is non-fatal: compression simply
            // stays off and the gateway passes requests through uncompressed.
            tracing::warn!(
                "headroom: could not start '{bin}' ({e}); compression will be inactive. \
                 Install with: pipx install \"headroom-ai[proxy]\""
            );
            return Ok(false);
        }

        for _ in 0..20 {
            if health_check(&headroom_url()).await {
                tracing::info!(url = %headroom_url(), "headroom: healthy, compression active");
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        tracing::warn!(
            url = %headroom_url(),
            "headroom: spawned but not healthy yet; gateway will pass through until it is"
        );
        Ok(false)
    }

    /// Whether a managed headroom child is currently running.
    pub fn is_running(&self) -> bool {
        self.handle.is_running()
    }

    /// Stop the managed headroom child (if any).
    pub async fn stop(&self) -> anyhow::Result<()> {
        self.handle.stop().await
    }
}

impl Default for HeadroomManager {
    fn default() -> Self {
        Self::new()
    }
}

/// GET `{base}/health`; returns true on a 2xx response.
async fn health_check(base_url: &str) -> bool {
    let endpoint = format!("{}/health", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    matches!(
        client
            .get(&endpoint)
            .timeout(Duration::from_millis(500))
            .send()
            .await,
        Ok(resp) if resp.status().is_success()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_defaults_to_loopback_8787() {
        if std::env::var(ENV_HEADROOM_URL).is_err() {
            assert_eq!(headroom_url(), DEFAULT_HEADROOM_URL);
        }
    }

    #[test]
    fn host_port_parses_default() {
        let (host, port) = host_port_from_url();
        assert!(!host.is_empty());
        assert!(port > 0);
    }

    #[test]
    fn set_enabled_drives_is_enabled() {
        // The plugin-driven flag is the source of truth: set_enabled flips what
        // is_enabled (and thus gateway_spawn_env) sees, deterministically and
        // independent of the RYU_HEADROOM_ENABLED dev seed. This test is the only
        // mutator of the process-global flag in the test binary.
        set_enabled(true);
        assert!(is_enabled(), "set_enabled(true) → is_enabled() true");
        set_enabled(false);
        assert!(!is_enabled(), "set_enabled(false) → is_enabled() false");
    }
}
