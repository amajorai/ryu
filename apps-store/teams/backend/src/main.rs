//! `ryu-teams` — the standalone, out-of-process agent-teams sidecar.
//!
//! Runs the extracted `ryu_teams` capability crate (the SQLite `TeamStore` + the
//! `/api/teams/*` CRUD surface, defined in `lib.rs`) as a SEPARATE PROCESS that
//! Core spawns, health-checks, and proxies to on loopback — exactly like
//! `ryu-mail`. The store and handlers live in the crate lib; this binary is only
//! the process shell around them, so the SAME crate still compiles into Core
//! in-process as a path dependency (no code is duplicated).
//!
//! The crate's [`ryu_teams::routes`] already returns a state-baked, state-less
//! `Router<()>` whose paths are RELATIVE to `/api/teams` (Core nests it at that
//! prefix in-process). This binary nests it under the same `/api/teams` prefix, so
//! the external paths are byte-identical to Core's in-process mount and the generic
//! ext-proxy forwards `/api/teams/*` to it unchanged.
//!
//! SECURITY: loopback-only bind (127.0.0.1) + a shared-secret bearer gate
//! (`RYU_EXT_TOKEN`, injected by Core at spawn and presented on the health probe +
//! every proxied hop). EVERY `/api/teams/*` route is protected — teams has NO public
//! surface (unlike mail's per-inbox-HMAC inbound webhook). The gate is FAIL-CLOSED:
//! with no token configured every protected route rejects with 401. `/health` is the
//! ONE un-gated route (loopback probe, returns no team data), so Core's pre-auth
//! health check succeeds — mirroring the finetune sidecar's top-level `/health`.
//!
//! Port: `RYU_TEAMS_PORT` env, default `7995`. Data dir: resolved via the inlined
//! `paths::ryu_dir` (`RYU_DIR`-env-first, injected by Core at spawn), so it opens
//! the SAME `teams.db` the node uses.

mod paths;

use std::net::{Ipv4Addr, SocketAddr};

use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::{from_fn, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;

use ryu_teams::{routes, TeamStore, TeamsCtx};

/// Default loopback port for the teams sidecar (overridable via `RYU_TEAMS_PORT`).
const DEFAULT_PORT: u16 = 7995;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_TEAMS_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Shared-secret bearer Core injects via the generic ext-proxy loader
    // (`RYU_EXT_TOKEN`) — the per-plugin minted secret it stamps on every proxied
    // hop + the health probe. The protected `/api/teams/*` routes require it.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!(
            "ryu-teams: protected /api/teams/* routes require the injected shared-secret bearer"
        );
    } else {
        tracing::warn!(
            "ryu-teams: no RYU_EXT_TOKEN set; protected /api/teams/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }

    let store = TeamStore::open(paths::ryu_dir().join("teams.db"))?;

    // The crate router (paths relative to `/api/teams`) nested under the external
    // prefix, with the shared-secret gate layered over the whole nest — teams has no
    // public route. `from_fn` closes over the resolved token so no extra state field
    // is needed.
    let gated_token = token.clone();
    let teams = Router::new()
        .nest("/api/teams", routes(TeamsCtx::new(store.clone())))
        .layer(from_fn(move |req: Request, next: Next| {
            let expected = gated_token.clone();
            async move { require_teams_token(req, next, expected.as_deref()).await }
        }));

    // `/health` sits OUTSIDE the gated nest so the loopback health probe succeeds
    // before auth. It asserts the store is readable (a cheap `list`) and returns no
    // team data.
    let health_store = store;
    let app = Router::new()
        .route(
            "/health",
            get(move || {
                let store = health_store.clone();
                async move { health(store).await }
            }),
        )
        .merge(teams);

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-teams sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Loopback health probe: asserts the store is readable (a cheap `list`) so health
/// also confirms DB readiness, not just process liveness. Un-gated and data-free.
async fn health(store: TeamStore) -> Response {
    match store.list().await {
        Ok(teams) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "teamCount": teams.len() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Shared-secret bearer gate for the proxied `/api/teams/*` surface. Core stays the
/// auth front — it runs `require_auth`, then re-stamps `Authorization: Bearer
/// <RYU_EXT_TOKEN>` on the loopback hop — so a request that did NOT come through Core
/// (any other local process on a shared host) is rejected with 401.
///
/// **Fail-closed:** `expected == None`/empty (no token configured) rejects every
/// request rather than falling open, so a bare-run or misconfigured sidecar never
/// serves team data unauthenticated.
async fn require_teams_token(req: Request, next: Next, expected: Option<&str>) -> Response {
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
