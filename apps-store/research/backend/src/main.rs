//! `ryu-research` — the standalone, out-of-process research sidecar.
//!
//! The out-of-process half of the `ryu_research` crate's in-process/out-of-process
//! duality (the same shape as `ryu-mail`): Core spawns THIS binary, health-checks
//! it, and reverse-proxies `/api/research/*` onto it through the generic ext-proxy
//! loader (`apps/core/src/sidecar/ext_proxy.rs`). Core does NOT contain this code,
//! so the research surface scales and fails independently of the rest of the node.
//!
//! It reuses the very same [`ryu_research::routes`] + [`ryu_research::ResearchCtx`]
//! the in-process merge uses — only nested under `/api/research` (Core forwards the
//! full mount path, `{mount}{sub_path}`) and guarded by the injected bearer.
//!
//! ## Two hops, by design
//!
//! The autoresearch *engine* (git-versioned workspaces, metric ledger) is the
//! dependency-free Python service on :8087. This Rust sidecar is a thin JSON proxy
//! in front of it, so a request is `Core → ryu-research (Rust) → autoresearch
//! (Python :8087)` — TWO loopback hops. Acceptable: both are same-host loopback and
//! the proxied calls (status/init/ledger) are quick; the long work happens inside
//! the Python engine, unaffected by the extra hop.
//!
//! ## Lazy-start stays Core-side (the one deliberate no-op)
//!
//! In-process, [`ryu_research::ResearchHost::start_sidecar`] lazy-starts the Python
//! engine through Core's `SidecarManager`. This binary can't reach that manager
//! (it lives in `apps/core`), so its [`SidecarHost`] impl makes `start_sidecar` a
//! no-op and assumes the engine is already reachable at
//! [`ryu_research::research_base_url`] (default `127.0.0.1:8087`, override
//! `RYU_RESEARCH_UPSTREAM`). Until Core is switched over to lazy-start the engine
//! independently, a request to a not-yet-started engine returns `502` with the
//! "install it from the Store" hint — the same graceful degradation the in-process
//! path shows when the engine is down. `is_installed()` still does the REAL on-disk
//! check, so `/status` never falsely reports the engine present.
//!
//! ## Security
//!
//! Binds LOOPBACK ONLY (127.0.0.1) and guards every route with the shared-secret
//! bearer `RYU_EXT_TOKEN` that Core mints per-plugin and stamps on both the proxied
//! hop and the health probe. Core is the auth front (`require_auth`), then
//! re-stamps `Authorization: Bearer <RYU_EXT_TOKEN>` on the loopback hop, so a
//! request that did NOT come through Core (any other local process on a shared
//! host) is rejected `401`. FAIL-CLOSED: with no token configured every route
//! rejects. Research has no external/public caller (unlike mail's inbound webhook),
//! so ALL routes are protected — there is no public sub-router.
//!
//! Port: `RYU_RESEARCH_PORT` env (Core injects the profile-shifted bind port via
//! the manifest's `port_env`), default `7995`.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Router,
};
use ryu_research::{routes, ResearchCtx, ResearchHost};

/// Default loopback port for the research sidecar (overridable via
/// `RYU_RESEARCH_PORT`). Distinct from browser (7993), mail (7996), the Python
/// autoresearch engine (8087), and every other declared sidecar port.
const DEFAULT_PORT: u16 = 7995;

/// The sidecar's [`ResearchHost`]. `start_sidecar` is a deliberate no-op (the
/// Python engine's lifecycle stays Core-side — see the module docs); `is_installed`
/// does the REAL on-disk check so `/status` is honest.
struct SidecarHost;

#[async_trait]
impl ResearchHost for SidecarHost {
    async fn start_sidecar(&self) -> Result<()> {
        // No-op: Core's `SidecarManager` owns the Python autoresearch engine
        // lifecycle; this out-of-process binary can't reach it. It assumes the
        // engine is reachable at `research_base_url()` and proxies to it. A call to
        // a down engine surfaces as a 502 from the proxy (graceful degradation).
        Ok(())
    }

    fn is_installed(&self) -> bool {
        // Mirror Core's `sidecar::tools::research::is_installed`: the engine *code*
        // is installed iff its Python package dir is present. The Rust sidecar
        // running does NOT imply the Python engine is installed (they install
        // separately), so this must be a real check, not a hardcoded `true`.
        sidecar_dir().join("ryu_research").is_dir()
    }
}

// ── On-disk install check (faithful, dependency-free copy of Core's resolution) ──
//
// Core injects `RYU_DIR` into the spawned sidecar's env (the load-bearing rule, as
// with `ryu-mail`), so the sidecar resolves the SAME data dir Core uses. The
// `RESEARCH_DIR` override and `~/.ryu{profile}/research-sidecar` default mirror
// `apps/core/src/sidecar/tools/research/mod.rs` byte-for-byte; the config-pointer
// read is intentionally omitted (Core's injected `RYU_DIR` supersedes it for the
// co-located child).

/// Data-dir suffix for the active profile: `""` for release, `-<profile>`
/// otherwise. Mirrors `crate::profile::suffix` / `ryu-mail`'s inlined copy.
fn profile_suffix() -> String {
    let profile = std::env::var("RYU_PROFILE")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "release".to_owned());
    if profile == "release" {
        String::new()
    } else {
        format!("-{}", profile.trim())
    }
}

/// The active data dir: `RYU_DIR` env first (Core injects it at spawn), else
/// `~/.ryu{suffix}` (falling back to `./.ryu{suffix}` when home is unknown).
fn ryu_dir() -> PathBuf {
    if let Some(v) = std::env::var_os("RYU_DIR") {
        let p = PathBuf::from(v);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    let name = format!(".ryu{}", profile_suffix());
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(name)
}

/// Directory holding the installed `ryu_research` package. Overridable via
/// `RESEARCH_DIR`; defaults to `<ryu_dir>/research-sidecar`.
fn sidecar_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("RESEARCH_DIR") {
        return PathBuf::from(dir);
    }
    ryu_dir().join("research-sidecar")
}

// ── Bearer gate (fail-closed; no public routes) ──────────────────────────────

/// Guard every route with the injected shared-secret bearer. FAIL-CLOSED: with no
/// token configured (`expected` is `None`), reject all. Mirrors `ryu-mail`'s
/// `require_mail_token`, minus the public inbound carve-out research doesn't have.
async fn require_ext_token(req: Request, next: Next, expected: Option<&str>) -> Response {
    let Some(expected) = expected else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let presented = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);
    let ok = presented.is_some_and(|got| ct_eq(got.as_bytes(), expected.as_bytes()));
    if ok {
        next.run(req).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

/// Constant-time byte compare — a length mismatch short-circuits to `false`, so it
/// never leaks the secret length via timing on the equal-length branch.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_RESEARCH_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Shared-secret bearer Core injects at spawn (the same `RYU_EXT_TOKEN` it stamps
    // on every proxied hop + the health probe). Every route requires it; FAIL-CLOSED
    // when absent.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!("ryu-research: all routes require the injected shared-secret bearer");
    } else {
        tracing::warn!(
            "ryu-research: no RYU_EXT_TOKEN set; all /api/research/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }

    // Reuse the crate's in-process router; nest it under `/api/research` because Core
    // forwards the FULL mount path (`{mount}{sub_path}`, e.g. `/api/research/status`).
    let ctx = ResearchCtx::new(Arc::new(SidecarHost));
    let app = Router::new()
        .nest("/api/research", routes(ctx))
        .layer(axum::middleware::from_fn(
            move |req: Request, next: Next| {
                let expected = token.clone();
                async move { require_ext_token(req, next, expected.as_deref()).await }
            },
        ));

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-research sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_matches_only_identical_bytes() {
        assert!(ct_eq(b"secret-token", b"secret-token"));
        assert!(!ct_eq(b"secret-token", b"secret-toke"));
        assert!(!ct_eq(b"secret-token", b"wrong-token!"));
        assert!(!ct_eq(b"", b"x"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn research_dir_env_overrides_install_check_path() {
        // `RESEARCH_DIR` wins over the `~/.ryu` default (matches Core's resolver).
        std::env::set_var("RESEARCH_DIR", "/tmp/ryu-research-test-dir");
        assert_eq!(sidecar_dir(), PathBuf::from("/tmp/ryu-research-test-dir"));
        std::env::remove_var("RESEARCH_DIR");
    }
}
