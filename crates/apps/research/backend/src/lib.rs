//! Research: the thin Rust surface in front of the autoresearch sidecar.
//!
//! The autoresearch *engine* — git-versioned experiment workspaces, a single
//! scalar metric parsed from stdout (lower = better), and a keep-if-improved-else-
//! reset git ledger — lives in the dependency-free Python sidecar
//! (`apps-store/research/sidecar`, stdlib HTTP on :8087). This crate is the Rust
//! surface the rest of Ryu reaches it through:
//!
//! - the **`/api/research/*` data path** ([`routes`]) — a thin JSON proxy
//!   (status / init-workspace / ledger) the desktop drives, and
//! - the **`research__*` MCP tool contract** ([`tool_specs`] + [`dispatch`]) — the
//!   8 tools a workflow `agent`/`tool` node loops over (init → read/write → run →
//!   keep/reset → ledger).
//!
//! Core-vs-Gateway (AGENTS.md §1): a research run decides *what runs* (which
//! experiment, in which workspace) — so it is **Core**. The researcher agent's own
//! model calls stay Gateway-governed.
//!
//! ## What stayed in the kernel
//!
//! The sidecar *lifecycle* (`ResearchManager: Sidecar` — adopt-or-spawn `python -m
//! ryu_research`, venv provisioning, health) stays in `apps/core`: it is generic
//! sidecar-manager plumbing (the `RyuTtsManager` analog the decomposition program
//! keeps in core), not research business logic. The two calls the moved surface
//! needs into that kernel — lazy-start the sidecar, and the on-disk install check —
//! are inverted through the [`ResearchHost`] trait, so this crate has ZERO
//! dependency on `apps/core`.

use anyhow::Result;
use async_trait::async_trait;

pub mod api;
mod mcp;

pub use api::{routes, ResearchCtx};
pub use mcp::{dispatch, tool_specs, ResearchToolSpec, SERVER_NAME};

/// Loopback port the research sidecar binds to. Distinct from llama.cpp (8080),
/// embeddings (8081), rerank (8082), sd (8083), mlx-vlm (8084), tts (8085),
/// whisper (8090). The Core-side `ResearchManager` references these so the port is
/// defined once, here, alongside the base-URL the proxy + tools call.
pub const RESEARCH_PORT: u16 = 8087;

/// `host:port` the sidecar binds to (the `ResearchManager` connect/adopt target).
pub const RESEARCH_ADDR: &str = "127.0.0.1:8087";

/// Base URL of the Python autoresearch engine the proxy ([`routes`]) and the
/// `research__*` tools ([`dispatch`]) forward to. Defaults to the loopback
/// `RESEARCH_ADDR` (`127.0.0.1:8087`) the Core-managed `ResearchManager` binds.
///
/// Overridable via `RYU_RESEARCH_UPSTREAM` — the seam the out-of-process
/// `ryu-research` sidecar bin uses when it must reach the engine at a non-default
/// address (accepts a bare `host:port` or a full `http(s)://…` URL). Unset — the
/// only state Core runs it in today — keeps the byte-identical default, so the
/// in-process path is unchanged.
pub fn research_base_url() -> String {
    if let Ok(up) = std::env::var("RYU_RESEARCH_UPSTREAM") {
        let up = up.trim();
        if !up.is_empty() {
            if up.starts_with("http://") || up.starts_with("https://") {
                return up.trim_end_matches('/').to_owned();
            }
            return format!("http://{up}");
        }
    }
    format!("http://{RESEARCH_ADDR}")
}

/// Whether a research sidecar is currently answering `/health` on the port. Used
/// by the status endpoint to report `running` without holding a manager.
pub async fn is_running_now(client: &reqwest::Client) -> bool {
    client
        .get(format!("{}/health", research_base_url()))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// The kernel couplings the moved research surface needs, inverted so this crate
/// stays free of any `apps/core` dependency. Core implements it (`research_host.rs`)
/// over the sidecar manager and installs it into the [`ResearchCtx`].
#[async_trait]
pub trait ResearchHost: Send + Sync {
    /// Lazily start the (off-by-default) research sidecar so the flow works once
    /// installed. Best-effort: a failure is surfaced so the caller can log it, but
    /// the request continues (the proxy call then reports the sidecar unreachable).
    async fn start_sidecar(&self) -> Result<()>;

    /// Whether the sidecar *code* is installed (its package dir is present). Reads
    /// through the Core-owned path resolution (`~/.ryu/research-sidecar`).
    fn is_installed(&self) -> bool;
}

/// Serializes every test in the LIB test binary that touches the process-global
/// `RYU_RESEARCH_UPSTREAM` env var (lib.rs + api.rs + mcp.rs compile into ONE test
/// binary). The bin (`main.rs`) is a separate process touching disjoint vars, so it
/// keeps its own lock. Poison-resilient: a panicking test must not cascade.
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Set `RYU_RESEARCH_UPSTREAM` under [`ENV_LOCK`], clearing it on drop. Held for the
/// whole test so no concurrent test observes the var mid-flight.
#[cfg(test)]
pub(crate) struct UpstreamGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl UpstreamGuard {
    /// Acquire the lock and set the upstream to `val` (pass `None` to assert the
    /// unset/default path).
    pub(crate) fn set(val: Option<&str>) -> Self {
        let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        match val {
            Some(v) => std::env::set_var("RYU_RESEARCH_UPSTREAM", v),
            None => std::env::remove_var("RYU_RESEARCH_UPSTREAM"),
        }
        Self { _lock: lock }
    }
}

#[cfg(test)]
impl Drop for UpstreamGuard {
    fn drop(&mut self) {
        std::env::remove_var("RYU_RESEARCH_UPSTREAM");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_defaults_to_loopback_when_unset() {
        let _g = UpstreamGuard::set(None);
        assert_eq!(research_base_url(), "http://127.0.0.1:8087");
    }

    #[test]
    fn base_url_wraps_bare_host_port_in_http() {
        let _g = UpstreamGuard::set(Some("10.0.0.4:9999"));
        assert_eq!(research_base_url(), "http://10.0.0.4:9999");
    }

    #[test]
    fn base_url_keeps_explicit_http_scheme_and_trims_trailing_slash() {
        let _g = UpstreamGuard::set(Some("http://example.test:8087/"));
        assert_eq!(research_base_url(), "http://example.test:8087");
    }

    #[test]
    fn base_url_preserves_https_scheme() {
        let _g = UpstreamGuard::set(Some("https://secure.test/base/"));
        assert_eq!(research_base_url(), "https://secure.test/base");
    }

    #[test]
    fn base_url_treats_whitespace_only_override_as_unset() {
        let _g = UpstreamGuard::set(Some("   "));
        assert_eq!(research_base_url(), "http://127.0.0.1:8087");
    }

    #[test]
    fn base_url_trims_surrounding_whitespace_before_parsing() {
        let _g = UpstreamGuard::set(Some("  host.test:1234  "));
        assert_eq!(research_base_url(), "http://host.test:1234");
    }

    #[tokio::test]
    async fn is_running_now_false_when_nothing_listens() {
        // Port 1 is not a listener; the connect fails fast → reported not-running.
        let _g = UpstreamGuard::set(Some("127.0.0.1:1"));
        let client = reqwest::Client::new();
        assert!(!is_running_now(&client).await);
    }

    #[tokio::test]
    async fn is_running_now_true_against_a_healthy_mock() {
        use axum::{routing::get, Router};
        let app = Router::new().route("/health", get(|| async { "ok" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let _g = UpstreamGuard::set(Some(&addr.to_string()));
        let client = reqwest::Client::new();
        assert!(is_running_now(&client).await);
    }

    #[tokio::test]
    async fn is_running_now_false_on_non_success_health() {
        use axum::{http::StatusCode, routing::get, Router};
        let app = Router::new()
            .route("/health", get(|| async { StatusCode::SERVICE_UNAVAILABLE }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let _g = UpstreamGuard::set(Some(&addr.to_string()));
        let client = reqwest::Client::new();
        assert!(!is_running_now(&client).await);
    }
}
