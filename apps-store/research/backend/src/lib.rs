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
