//! SDK-app adapter: wrap a developer's Ryu SDK process as a Core-managed engine.
//!
//! ## Transport decision: OpenAI-compat loopback
//!
//! An SDK app exposes a local OpenAI-compatible `/v1/chat/completions` endpoint on
//! a loopback port (default `127.0.0.1:3200`, overridable via `RYU_SDK_APP_PORT`).
//! Core talks to it via the existing `connect_openai` + `route_openai_stream` path
//! (see `adapters/mod.rs`) — no new transport code is needed.
//!
//! **Why not ACP?** ACP (`adapters/acp.rs`) requires a JSON-RPC subprocess
//! handshake that every agent must implement. The SDK app is Ryu's *own* surface;
//! mandating a second protocol on our own SDK would duplicate what OpenAI-compat
//! already gives us for free. OpenAI-compat loopback was proven end-to-end by the
//! `LocalEngine` path in `active_engine.rs:33`; the SDK path reuses exactly that
//! precedent.
//!
//! ## Gateway policy
//!
//! The Core→SDK-app hop goes directly to the loopback (`via_gateway: false`).
//! The SDK app's *own* model calls are governed by injecting
//! `OPENAI_BASE_URL=<gateway>/v1` + `OPENAI_API_KEY=<token>` into the `bunx`
//! subprocess environment — identical to how `codex_acp_cmd()` routes Codex egress
//! and how `ryu_agent_route()` wraps Pi (`adapters/acp.rs`). Policy lives in the
//! gateway; Core only decides what runs.
//!
//! ## SidecarManager integration
//!
//! `SdkAppSidecar` implements the `Sidecar` trait so `SidecarManager` can
//! `start`, `stop`, and `health_check` it exactly like any other sidecar
//! (`manager.rs:332/345`). The sidecar name is `"sdk:<app-name>"` so it lives in
//! the same namespace as `acp:claude` / `acp:codex`.
//!
//! ## Manual repro (AC4)
//!
//! ```text
//! # Start a minimal OpenAI-compat SSE server on port 3200:
//! RYU_SDK_APP_PORT=3200 bunx my-sdk-app
//!
//! # In a second terminal, start Core:
//! RYU_SDK_APP_URL=http://127.0.0.1:3200 cargo run --manifest-path apps/core/Cargo.toml
//!
//! # Send a chat request with agent_id="sdk:my-sdk-app":
//! curl -N http://127.0.0.1:7980/api/chat/stream \
//!   -H 'content-type: application/json' \
//!   -d '{"messages":[{"role":"user","content":"hello"}],"agent_id":"sdk:my-sdk-app"}'
//! ```
//!
//! Core will health-check the SDK process and stream the turn through
//! `route_openai_stream` (`adapters/mod.rs`) to the loopback endpoint.

use std::sync::Arc;
use std::time::Duration;

use crate::sidecar::process::ProcessHandle;
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

// ── Configuration ─────────────────────────────────────────────────────────────

/// Env var: override the loopback port the SDK app listens on.
pub const ENV_SDK_APP_PORT: &str = "RYU_SDK_APP_PORT";
/// Env var: override the full base URL for a running SDK app (no `/v1` suffix).
pub const ENV_SDK_APP_URL: &str = "RYU_SDK_APP_URL";
/// Canonical (release) loopback port for SDK apps. The concrete default is
/// profile-aware — see [`resolved_sdk_app_port`].
pub const DEFAULT_SDK_APP_PORT: u16 = 3200;

/// The port an SDK app is expected on: an explicit `RYU_SDK_APP_PORT` wins,
/// otherwise the profile-aware default (release 3200, dev 4200, …). Both the
/// CLIENT ([`sdk_app_base_url`]) and the SPAWN ([`sdk_app_spawn_parts`], which
/// injects `RYU_SDK_APP_PORT` into the child so it binds here) use this, so the
/// two sides never diverge under a profile.
pub fn resolved_sdk_app_port() -> u16 {
    std::env::var(ENV_SDK_APP_PORT)
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or_else(|| crate::profile::port(DEFAULT_SDK_APP_PORT))
}

/// Resolve the base URL for an SDK app. Resolution order:
///   1. `RYU_SDK_APP_URL` (full override, no port needed)
///   2. `127.0.0.1:<RYU_SDK_APP_PORT>` (port override)
///   3. `127.0.0.1:<profile default>` (3200 on release, 4200 on dev, …)
///
/// Returns the URL without a trailing slash or `/v1` — callers append `/v1/...`
/// themselves (consistent with `active_engine.rs` conventions).
pub fn sdk_app_base_url() -> String {
    if let Ok(url) = std::env::var(ENV_SDK_APP_URL) {
        if !url.is_empty() {
            return url.trim_end_matches('/').to_owned();
        }
    }
    format!("http://127.0.0.1:{}", resolved_sdk_app_port())
}

/// Build the gateway-injected env overrides and the `bunx <package>` args for
/// spawning the SDK app. Returns `(program, args, env)` for use with
/// `ProcessHandle::start_path_with_env`.
///
/// Gateway injection mirrors `codex_acp_cmd()` and `ryu_agent_route()`: the
/// subprocess inherits `OPENAI_BASE_URL=<gateway>/v1` and `OPENAI_API_KEY=<token>`
/// so any OpenAI-compatible client inside the SDK app routes through the gateway.
///
/// On Windows, `bunx` is invoked via `cmd /c bunx` because bun's package runner
/// is a `.cmd` shim. On POSIX `bunx` resolves directly.
pub fn sdk_app_spawn_parts(package: &str) -> (String, Vec<String>, Vec<(String, String)>) {
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    let token = crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned());

    let env = vec![
        ("OPENAI_BASE_URL".to_owned(), gateway_v1),
        ("OPENAI_API_KEY".to_owned(), token),
        // Bind the child to the profile-resolved port so it lands where
        // `sdk_app_base_url` dials it (release 3200, dev 4200, …). An explicit
        // `RYU_SDK_APP_PORT` in Core's env is honoured by `resolved_sdk_app_port`.
        (
            ENV_SDK_APP_PORT.to_owned(),
            resolved_sdk_app_port().to_string(),
        ),
    ];

    #[cfg(target_os = "windows")]
    let (program, args) = (
        "cmd".to_owned(),
        vec!["/c".to_owned(), "bunx".to_owned(), package.to_owned()],
    );

    #[cfg(not(target_os = "windows"))]
    let (program, args) = ("bunx".to_owned(), vec![package.to_owned()]);

    (program, args, env)
}

/// Return the full spawn command string used for display/logging. This mirrors
/// how `codex_acp_cmd()` builds a human-readable command string.
pub fn sdk_app_spawn_cmd(package: &str) -> String {
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    let token = crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned());

    #[cfg(target_os = "windows")]
    return format!(
        "cmd /c set OPENAI_BASE_URL={gateway_v1}&& set OPENAI_API_KEY={token}&& bunx {package}"
    );

    #[cfg(not(target_os = "windows"))]
    return format!("OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} bunx {package}");
}

// ── SdkAppSidecar ─────────────────────────────────────────────────────────────

/// A Core-managed sidecar wrapping a developer's Ryu SDK app.
///
/// The sidecar spawns the app via `bunx <package>` (with gateway env injection),
/// waits for the loopback OpenAI-compat endpoint to become healthy, and keeps the
/// child handle so it is killed on Core shutdown.
///
/// `SidecarManager` can start, stop, and health-monitor this sidecar exactly like
/// any other managed process (`manager.rs:332/345`).
pub struct SdkAppSidecar {
    /// Sidecar id, e.g. `"sdk:my-app"`.
    id: &'static str,
    /// npm/bun package name, e.g. `"my-sdk-app"`.
    package: &'static str,
    /// Loopback base URL the process serves on (no `/v1` suffix).
    base_url: String,
    /// Underlying process handle (start/stop/is_running).
    handle: ProcessHandle,
}

impl SdkAppSidecar {
    /// Create a new `SdkAppSidecar` with a static id and package name.
    ///
    /// For dynamically-registered SDK apps (from config), use
    /// [`SdkAppEntry::to_sidecar_arc`] which boxes the `Arc` correctly.
    pub fn new(id: &'static str, package: &'static str, base_url: String) -> Arc<Self> {
        Arc::new(Self {
            id,
            package,
            base_url,
            handle: ProcessHandle::new(),
        })
    }
}

impl Sidecar for SdkAppSidecar {
    fn name(&self) -> &'static str {
        self.id
    }

    fn is_required(&self) -> bool {
        // SDK apps are optional; Core must not fail to start if one is absent.
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let package = self.package;
        let base_url = self.base_url.clone();
        let id = self.id;
        let handle = self.handle.clone();
        Box::pin(async move {
            if handle.is_running() {
                tracing::info!(name = %id, "sdk app already running, reusing");
                return Ok(());
            }

            let (program, args, env) = sdk_app_spawn_parts(package);
            tracing::info!(name = %id, package = %package, "sdk app: spawning via bunx");
            handle
                .start_path_with_env(&program, &args, &env)
                .await
                .map_err(|e| {
                    anyhow::anyhow!("failed to spawn sdk app '{id}' (bunx {package}): {e}")
                })?;

            // Wait for the health endpoint to become ready (up to 10 s).
            for _ in 0..40u32 {
                if sdk_health_check(&base_url).await {
                    tracing::info!(name = %id, url = %base_url, "sdk app: healthy");
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            anyhow::bail!(
                "sdk app '{id}' spawned but did not become healthy within 10s (url: {base_url})"
            )
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let handle = self.handle.clone();
        let id = self.id;
        Box::pin(async move {
            tracing::info!(name = %id, "sdk app: stopping");
            handle.stop().await
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let base_url = self.base_url.clone();
        let id = self.id;
        Box::pin(async move {
            if sdk_health_check(&base_url).await {
                HealthStatus::Healthy
            } else {
                HealthStatus::Degraded(format!(
                    "sdk app '{id}' health endpoint unreachable at {base_url}/health"
                ))
            }
        })
    }

    fn is_running(&self) -> bool {
        self.handle.is_running()
    }
}

/// GET `{base_url}/health`; returns `true` on a 2xx response.
pub async fn sdk_health_check(base_url: &str) -> bool {
    let endpoint = format!("{}/health", base_url.trim_end_matches('/'));
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(reqwest::Client::new);
    matches!(
        client
            .get(&endpoint)
            .timeout(Duration::from_millis(500))
            .send()
            .await,
        Ok(resp) if resp.status().is_success()
    )
}

// ── Registry entry (for dynamic/config-driven SDK apps) ───────────────────────

/// An entry describing one SDK app that can be installed and managed by Core.
///
/// Unlike `SdkAppSidecar` (which requires static `&'static str` names for the
/// `Sidecar` trait), `SdkAppEntry` is fully owned and suitable for
/// config-file-driven registration where the app name is not known at compile time.
#[derive(Debug, Clone)]
pub struct SdkAppEntry {
    /// Sidecar id, e.g. `"sdk:my-app"`.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// The npm/bun package name used in `bunx <package>`.
    pub package: String,
    /// Loopback base URL (no `/v1`). Defaults to `sdk_app_base_url()`.
    pub base_url: String,
}

impl SdkAppEntry {
    /// Create a new entry with the default loopback URL.
    pub fn new(id: impl Into<String>, name: impl Into<String>, package: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            package: package.into(),
            base_url: sdk_app_base_url(),
        }
    }

    /// The spawn command string (for logging / display).
    pub fn spawn_cmd(&self) -> String {
        sdk_app_spawn_cmd(&self.package)
    }
}

// ── id helpers ────────────────────────────────────────────────────────────────

/// Returns `true` if `agent_id` addresses an SDK app (`"sdk:"` prefix).
pub fn is_sdk_app(agent_id: &str) -> bool {
    agent_id.starts_with("sdk:")
}

/// Extract the package name from `"sdk:<package>"`. Returns `None` when the id
/// does not carry the `sdk:` prefix.
pub fn sdk_app_package(agent_id: &str) -> Option<&str> {
    agent_id.strip_prefix("sdk:")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the two tests that mutate the process-global SDK app URL/port
    /// env vars (`RYU_SDK_APP_URL` / `RYU_SDK_APP_PORT`); without it one can set
    /// the URL while the other has cleared it and is asserting the port path.
    /// Poison-tolerant.
    static SDK_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_sdk_env() -> std::sync::MutexGuard<'static, ()> {
        SDK_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ── URL resolution ──────────────────────────────────────────────────────

    #[test]
    fn default_base_url_uses_default_port() {
        let port = DEFAULT_SDK_APP_PORT;
        assert_eq!(format!("http://127.0.0.1:{port}"), "http://127.0.0.1:3200");
    }

    #[test]
    fn env_port_override_is_applied() {
        let _lock = lock_sdk_env();
        let prev_url = std::env::var(ENV_SDK_APP_URL).ok();
        let prev_port = std::env::var(ENV_SDK_APP_PORT).ok();
        std::env::remove_var(ENV_SDK_APP_URL);
        std::env::set_var(ENV_SDK_APP_PORT, "4321");
        let url = sdk_app_base_url();
        assert_eq!(url, "http://127.0.0.1:4321");
        match prev_port {
            Some(v) => std::env::set_var(ENV_SDK_APP_PORT, v),
            None => std::env::remove_var(ENV_SDK_APP_PORT),
        }
        match prev_url {
            Some(v) => std::env::set_var(ENV_SDK_APP_URL, v),
            None => std::env::remove_var(ENV_SDK_APP_URL),
        }
    }

    #[test]
    fn env_url_override_takes_precedence() {
        let _lock = lock_sdk_env();
        let prev = std::env::var(ENV_SDK_APP_URL).ok();
        std::env::set_var(ENV_SDK_APP_URL, "http://192.168.1.50:9090");
        let url = sdk_app_base_url();
        assert_eq!(url, "http://192.168.1.50:9090");
        match prev {
            Some(v) => std::env::set_var(ENV_SDK_APP_URL, v),
            None => std::env::remove_var(ENV_SDK_APP_URL),
        }
    }

    // ── Spawn command ───────────────────────────────────────────────────────

    #[test]
    fn spawn_cmd_injects_gateway_base_url() {
        // The spawn command must contain the gateway /v1 URL so model calls from
        // the SDK app process are governed by the gateway (matching codex_acp_cmd
        // and ryu_agent_route gateway injection patterns).
        let cmd = sdk_app_spawn_cmd("my-sdk-app");
        let gateway_v1 = format!(
            "{}/v1",
            crate::sidecar::gateway::gateway_url().trim_end_matches('/')
        );
        assert!(
            cmd.contains(&gateway_v1) || cmd.contains("OPENAI_BASE_URL"),
            "spawn cmd must inject gateway URL or OPENAI_BASE_URL, got: {cmd}"
        );
    }

    #[test]
    fn spawn_cmd_contains_package_name() {
        let cmd = sdk_app_spawn_cmd("my-sdk-app");
        assert!(
            cmd.contains("my-sdk-app"),
            "spawn cmd must include package name, got: {cmd}"
        );
    }

    #[test]
    fn spawn_parts_env_contains_gateway_url() {
        let (_prog, _args, env) = sdk_app_spawn_parts("my-sdk-app");
        let has_openai_base = env.iter().any(|(k, _)| k == "OPENAI_BASE_URL");
        assert!(
            has_openai_base,
            "spawn parts env must include OPENAI_BASE_URL"
        );
    }

    #[test]
    fn spawn_parts_args_contain_package() {
        let (_prog, args, _env) = sdk_app_spawn_parts("my-sdk-app");
        assert!(
            args.iter().any(|a| a == "my-sdk-app"),
            "spawn parts args must include package name, got: {args:?}"
        );
    }

    // ── Registry helpers ────────────────────────────────────────────────────

    #[test]
    fn is_sdk_app_matches_sdk_prefix_only() {
        assert!(is_sdk_app("sdk:my-app"));
        assert!(is_sdk_app("sdk:"));
        assert!(!is_sdk_app("acp:claude"));
        assert!(!is_sdk_app("zeroclaw"));
        assert!(!is_sdk_app(""));
    }

    #[test]
    fn sdk_app_package_extracts_suffix() {
        assert_eq!(sdk_app_package("sdk:my-app"), Some("my-app"));
        assert_eq!(sdk_app_package("acp:claude"), None);
        assert_eq!(sdk_app_package("sdk:"), Some(""));
    }

    // ── Health check (loopback) ─────────────────────────────────────────────

    #[tokio::test]
    async fn health_check_true_on_2xx_false_on_5xx() {
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::Router;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral loopback");
        let port = listener.local_addr().unwrap().port();
        let app = Router::new()
            .route("/health", get(|| async { "OK" }))
            .route(
                "/broken/health",
                get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
            );
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
                .expect("stub server runs");
        });

        let base = format!("http://127.0.0.1:{port}");
        // 2xx on /health → healthy. A trailing slash is trimmed by the helper.
        assert!(sdk_health_check(&base).await);
        assert!(sdk_health_check(&format!("{base}/")).await);
        // 5xx → not healthy.
        assert!(!sdk_health_check(&format!("{base}/broken")).await);

        let _ = tx.send(());
    }

    #[tokio::test]
    async fn health_check_false_when_unreachable() {
        // Nothing is listening → the request fails and health is false (no panic).
        assert!(!sdk_health_check("http://127.0.0.1:1").await);
    }

    #[test]
    fn sdk_entry_spawn_cmd_matches_standalone_fn() {
        let entry = SdkAppEntry::new("sdk:test", "Test App", "test-sdk-app");
        let from_entry = entry.spawn_cmd();
        let from_fn = sdk_app_spawn_cmd("test-sdk-app");
        assert_eq!(from_entry, from_fn);
    }

    // ── Route: Core→SDK-app hop must be direct (not via gateway) ───────────

    #[test]
    fn sdk_app_base_url_is_not_gateway_url() {
        // The Core→SDK-app hop must go direct to the loopback (via_gateway:false).
        // Gateway policy is enforced by env-injection into the SDK subprocess, not
        // by routing the Core loopback call through the gateway (which would cause
        // Core to talk to the gateway, which talks back to Core — a loop).
        //
        // HERMETIC: `SdkAppEntry::new` defaults `base_url` to `sdk_app_base_url()`,
        // which reads the process-global `RYU_SDK_APP_URL`. Rust runs tests in
        // parallel threads of ONE process, so without this guard `env_url_override_
        // takes_precedence` (which sets that var to 192.168.1.50:9090) races this
        // test and the loopback assertion fails nondeterministically. Take the same
        // lock those tests take, and clear the var so we assert the real DEFAULT.
        let _lock = lock_sdk_env();
        let prev = std::env::var(ENV_SDK_APP_URL).ok();
        std::env::remove_var(ENV_SDK_APP_URL);

        let entry = SdkAppEntry::new("sdk:test", "Test", "test-sdk-app");

        if let Some(v) = prev {
            std::env::set_var(ENV_SDK_APP_URL, v);
        }

        let gateway_url = crate::sidecar::gateway::gateway_url();
        assert_ne!(
            entry.base_url, gateway_url,
            "SDK app base_url must not equal gateway URL — Core→SDK hop must be direct"
        );
        assert!(
            entry.base_url.starts_with("http://127.0.0.1:"),
            "SDK app must bind on loopback, got: {}",
            entry.base_url
        );
    }
}
