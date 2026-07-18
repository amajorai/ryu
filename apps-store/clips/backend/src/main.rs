//! `ryu-clips` — the standalone, out-of-process clips sidecar.
//!
//! Runs the extracted `ryu_clips` capability crate (the `/api/clips/*` Core→Shadow
//! capture proxy, defined in `lib.rs` + `api.rs`) as a SEPARATE PROCESS that Core
//! spawns, health-checks, and proxies to on loopback — exactly like `ryu-mail` /
//! `ryu-teams`. The handlers live in the crate lib; this binary is only the process
//! shell around them, so the SAME crate still compiles into Core in-process as a
//! path dependency (no code is duplicated).
//!
//! The crate's [`ryu_clips::routes`] already returns a state-baked, state-less
//! `Router<()>` whose paths are RELATIVE to `/api/clips` (Core nests it at that
//! prefix in-process). This binary nests it under the same `/api/clips` prefix, so
//! the external paths are byte-identical to Core's in-process mount and the generic
//! ext-proxy forwards `/api/clips/*` to it unchanged.
//!
//! ## What works out-of-process, and what degrades
//! The crate proxies the record/browse surface DIRECTLY to Shadow reading
//! `RYU_SHADOW_URL` itself, so the whole Shadow half is fully live here:
//! start/stop/pause/resume, `:id/frame`, `:id/file`, `:id/context`, `sources`,
//! `recent-activity`, `:id/diagnostics`, AND local-file `ingest` (which never
//! touches the host download path).
//!
//! The two [`ryu_clips::ClipsHost`] couplings need Core's kernel machinery, which is
//! NOT reachable from this process without an HTTP call back into Core's hot loop
//! (a reverse-coupling we deliberately do not weld). So this bin's concrete host
//! degrades them CLEANLY:
//!   - **URL / yt-dlp ingest** (`ensure_ytdlp` / `download_video`) needs Core's
//!     `DownloadCenter` (yt-dlp binary management). Both return `Err(_)`; the crate's
//!     ingest handler already turns that into a clean `502` with a clear reason, so
//!     URL ingest fails soft while local-file ingest keeps working.
//!   - **Auto-file into the `Clips` Space** (`store_clip`) needs Core's Spaces store.
//!     Its trait signature returns `()` (Core spawns it fire-and-forget), so it has
//!     NO error channel — it can only LOG a warning. The clip HTTP response is
//!     unaffected either way (Core never awaited the filing in-process either).
//!
//! SECURITY: loopback-only bind (127.0.0.1) + a shared-secret bearer gate
//! (`RYU_EXT_TOKEN`, injected by Core at spawn and presented on the health probe +
//! every proxied hop). EVERY `/api/clips/*` route is protected — clips has NO public
//! surface. The gate is FAIL-CLOSED: with no token configured every protected route
//! rejects with 401. `/health` is the ONE un-gated route (loopback probe, returns no
//! clip data), so Core's pre-auth health check succeeds — mirroring `ryu-teams`.
//!
//! Port: `RYU_CLIPS_PORT` env, default `7992`. Data dir: resolved via the inlined
//! `paths::ryu_dir` (`RYU_DIR`-env-first, injected by Core at spawn), so ingest work
//! dirs land under the SAME `${RYU_DIR}/tmp` the node uses.

mod paths;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path as StdPath, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::{from_fn, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;

use ryu_clips::{routes, ClipsCtx, ClipsHost, DownloadedClip};

/// Default loopback port for the clips sidecar (overridable via `RYU_CLIPS_PORT`).
const DEFAULT_PORT: u16 = 7992;

/// The concrete [`ClipsHost`] for the STANDALONE sidecar.
///
/// Provides the one thing it can honestly own out-of-process — the ingest work-dir
/// base (`${RYU_DIR}/tmp`) — and degrades the two Core-kernel-coupled operations
/// (see the module docs) cleanly: yt-dlp ingest returns a clear `Err`, Space filing
/// logs a warning (its `()` signature has no error channel).
struct SidecarClipsHost;

/// The reason string surfaced when a Core-broker-back-only capability is invoked in
/// the standalone sidecar. Kept in one place so the yt-dlp `Err` and the Space-fill
/// warning read consistently.
const BROKER_BACK_HINT: &str =
    "requires Core's kernel machinery (DownloadCenter / Spaces store), which the \
     standalone ryu-clips sidecar does not link; use the in-process (Core-linked) \
     build for this path";

#[async_trait]
impl ClipsHost for SidecarClipsHost {
    fn tmp_dir(&self) -> PathBuf {
        paths::ryu_dir().join("tmp")
    }

    async fn ensure_ytdlp(&self) -> Result<(), String> {
        // yt-dlp is installed + managed by Core's DownloadCenter (kernel binary
        // management). Degrade with a clear Err — the crate's ingest handler turns
        // this into a clean 502 for URL ingest; local-file ingest is unaffected.
        Err(format!("URL ingest {BROKER_BACK_HINT}"))
    }

    async fn download_video(
        &self,
        _url: &str,
        _work_dir: &StdPath,
        _start: Option<u64>,
        _end: Option<u64>,
    ) -> Result<DownloadedClip, String> {
        // Unreachable in practice (`ensure_ytdlp` fails first), but the trait demands
        // a body — keep the same clear, broker-back reason.
        Err(format!("URL ingest {BROKER_BACK_HINT}"))
    }

    async fn store_clip(&self, title: &str, _mp4: Option<Vec<u8>>, _summary_md: &str) {
        // Filing into the `Clips` Space needs Core's Spaces store. This method
        // returns `()` (Core spawns it fire-and-forget), so it has NO error channel —
        // the ONLY honest degrade is to log. The clip HTTP response is unaffected.
        tracing::warn!(
            clip = %title,
            "ryu-clips: skipping auto-file into the `Clips` Space — {BROKER_BACK_HINT}"
        );
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_CLIPS_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Shared-secret bearer Core injects via the generic ext-proxy loader
    // (`RYU_EXT_TOKEN`) — the per-plugin minted secret it stamps on every proxied
    // hop + the health probe. The protected `/api/clips/*` routes require it.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!(
            "ryu-clips: protected /api/clips/* routes require the injected shared-secret bearer"
        );
    } else {
        tracing::warn!(
            "ryu-clips: no RYU_EXT_TOKEN set; protected /api/clips/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }

    // The crate router (paths relative to `/api/clips`) nested under the external
    // prefix, with the shared-secret gate layered over the whole nest — clips has no
    // public route. `from_fn` closes over the resolved token so no extra state field
    // is needed.
    let host: Arc<dyn ClipsHost> = Arc::new(SidecarClipsHost);
    let ctx = ClipsCtx::new(reqwest::Client::new(), host);
    let gated_token = token.clone();
    let clips = Router::new()
        .nest("/api/clips", routes(ctx))
        .layer(from_fn(move |req: Request, next: Next| {
            let expected = gated_token.clone();
            async move { require_clips_token(req, next, expected.as_deref()).await }
        }));

    // `/health` sits OUTSIDE the gated nest so the loopback health probe succeeds
    // before auth. It is a STATIC liveness check — it does NOT probe Shadow, because
    // clips is fail-soft when Shadow is down (the sidecar process is still healthy).
    let app = Router::new().route("/health", get(health)).merge(clips);

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-clips sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Loopback health probe: static process-liveness only (clips owns no store and is
/// fail-soft on Shadow, so there is nothing to assert but that we are serving).
/// Un-gated and data-free.
async fn health() -> Response {
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

/// Shared-secret bearer gate for the proxied `/api/clips/*` surface. Core stays the
/// auth front — it runs `require_auth`, then re-stamps `Authorization: Bearer
/// <RYU_EXT_TOKEN>` on the loopback hop — so a request that did NOT come through Core
/// (any other local process on a shared host) is rejected with 401.
///
/// **Fail-closed:** `expected == None`/empty (no token configured) rejects every
/// request rather than falling open, so a bare-run or misconfigured sidecar never
/// serves clip data unauthenticated.
async fn require_clips_token(req: Request, next: Next, expected: Option<&str>) -> Response {
    let provided = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if bearer_ok(provided, expected) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
    }
}

/// Pure bearer check (factored out so the auth decision is unit-testable without an
/// axum `Request`/`Next`). Returns `true` only when `expected` is a non-empty token
/// AND `provided` equals it (constant-time compared). A `None`/empty `expected` is
/// the fail-closed case → always `false`.
fn bearer_ok(provided: Option<&str>, expected: Option<&str>) -> bool {
    let Some(expected) = expected.filter(|t| !t.is_empty()) else {
        return false;
    };
    ct_eq(provided.unwrap_or("").as_bytes(), expected.as_bytes())
}

/// Constant-time byte comparison — no early return on the first mismatched byte, so
/// the token check does not leak length/prefix via timing.
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

#[cfg(test)]
mod tests {
    use super::bearer_ok;

    #[test]
    fn bearer_ok_matches_only_exact_nonempty_token() {
        assert!(bearer_ok(Some("secret"), Some("secret")));
        assert!(!bearer_ok(Some("secret"), Some("other")));
        assert!(!bearer_ok(Some("secre"), Some("secret")));
        assert!(!bearer_ok(None, Some("secret")));
    }

    #[test]
    fn bearer_ok_is_fail_closed_without_expected() {
        // No/empty configured token → reject everything, even a matching-looking hdr.
        assert!(!bearer_ok(Some("secret"), None));
        assert!(!bearer_ok(Some(""), Some("")));
        assert!(!bearer_ok(None, None));
    }
}
