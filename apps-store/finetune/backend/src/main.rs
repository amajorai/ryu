//! `ryu-finetune` — the standalone, out-of-process fine-tuning control-plane sidecar.
//!
//! Runs the extracted `ryu_finetune` capability crate (the SQLite `FinetuneStore`,
//! the adapter catalog, and the `/api/finetune/*` HTTP surface defined in
//! `api.rs`) as a SEPARATE PROCESS that Core spawns, health-checks, and proxies to
//! on loopback — exactly like `ryu-research` fronts the Python autoresearch engine.
//! This binary sits IN FRONT of the Python `unsloth` training worker: it does not
//! train, it drives the worker over HTTP at `RYU_UNSLOTH_URL` (default
//! `http://127.0.0.1:8086`), owns the durable job records, gates local training on
//! the GPU, and registers merged adapter GGUFs as installed models.
//!
//! The crate's [`ryu_finetune::routes`] returns a state-baked, state-less
//! `Router<()>` whose paths are RELATIVE to `/api/finetune`. This binary nests it
//! under the same `/api/finetune` prefix, so the external paths are byte-identical
//! to Core's in-process mount and the generic ext-proxy forwards `/api/finetune/*`
//! to it unchanged.
//!
//! SECURITY: loopback-only bind (127.0.0.1) + a shared-secret bearer gate
//! (`RYU_EXT_TOKEN`, injected by Core at spawn and presented on every proxied hop).
//! EVERY `/api/finetune/*` route is protected — finetune has NO public surface. The
//! gate is FAIL-CLOSED: with no token configured every protected route rejects with
//! 401. `/health` is the ONE un-gated route (loopback probe, returns no job data),
//! so Core's pre-auth health check succeeds — mirroring `ryu-teams`.
//!
//! Port: `RYU_FINETUNE_PORT` env, default `7992`. Data dir: resolved via the inlined
//! `paths::ryu_dir` (`RYU_DIR`-env-first, injected by Core at spawn), so it opens the
//! SAME `finetune.db` and shares the SAME `installed-adapters.json` /
//! `installed-models.json` indices the node uses.

mod paths;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::{from_fn, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;

use ryu_finetune::api::DEFAULT_UNSLOTH_URL;
use ryu_finetune::{routes, FinetuneCtx, FinetuneStore};
use ryu_model_catalog::{set_global_host, DefaultModelRepos, ModelCatalogHost};

/// Default loopback port for the finetune control-plane sidecar (overridable via
/// `RYU_FINETUNE_PORT`). Distinct from browser (7993), teams (7994), research
/// (7995), mail (7996), dashboards (7997), and the Python unsloth worker (8086).
const DEFAULT_PORT: u16 = 7992;

/// Minimal [`ModelCatalogHost`] for the sidecar process. The `/api/finetune/*`
/// surface reaches the model catalog only to WRITE the merged-adapter provenance
/// index (`installed::record`), which touches nothing but [`ryu_dir`]. Every other
/// trait method is on the download/registry read path Core owns and is NEVER called
/// out here, so the stubs fail loudly rather than returning a plausible-but-wrong
/// default. The `ryu_dir` is the SAME `${RYU_DIR}` Core resolves, so the sidecar
/// writes the exact `installed-models.json` Core reads.
struct SidecarCatalogHost {
    ryu_dir: PathBuf,
}

#[async_trait::async_trait]
impl ModelCatalogHost for SidecarCatalogHost {
    fn ryu_dir(&self) -> PathBuf {
        self.ryu_dir.clone()
    }

    fn authorize_hf(&self, _req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        unimplemented!("ryu-finetune sidecar never issues Hugging Face Hub requests")
    }

    fn supported_on_node(&self, _engine: &str) -> bool {
        unimplemented!("ryu-finetune sidecar never resolves per-node engine support")
    }

    fn default_model_repos(&self) -> DefaultModelRepos {
        unimplemented!("ryu-finetune sidecar never reads the default model registry")
    }

    async fn active_model_pref(&self) -> Option<String> {
        unimplemented!("ryu-finetune sidecar never reads the active-model preference")
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

    let port: u16 = std::env::var("RYU_FINETUNE_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Shared-secret bearer Core injects via the generic ext-proxy loader
    // (`RYU_EXT_TOKEN`) — the per-plugin minted secret it stamps on every proxied
    // hop + the health probe. The protected `/api/finetune/*` routes require it.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!(
            "ryu-finetune: protected /api/finetune/* routes require the injected shared-secret bearer"
        );
    } else {
        tracing::warn!(
            "ryu-finetune: no RYU_EXT_TOKEN set; protected /api/finetune/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }

    // Resolve the shared data dir ONCE and publish it to both consumers: the crate's
    // own `finetune.db` / adapter catalog (`init_data_dir`) and the model catalog
    // (`set_global_host`) used to register merged models.
    let ryu_dir = paths::ryu_dir();
    ryu_finetune::init_data_dir(ryu_dir.clone());
    set_global_host(Arc::new(SidecarCatalogHost {
        ryu_dir: ryu_dir.clone(),
    }));

    // Base URL of the Python Unsloth training worker. Core injects `RYU_UNSLOTH_URL`
    // (pointing at the worker's profile-shifted loopback port) at spawn; the default
    // matches the manifest-declared `8086`.
    let unsloth_url =
        std::env::var("RYU_UNSLOTH_URL").unwrap_or_else(|_| DEFAULT_UNSLOTH_URL.to_string());

    // Un-timed client: the adapter→GGUF merge and the SSE progress stream are
    // long-running, so no request timeout (mirrors Core's un-timed `ServerState::client`).
    let client = reqwest::Client::builder()
        .user_agent("ryu-finetune/0.1")
        .build()?;

    let store = FinetuneStore::open(ryu_dir.join("finetune.db"))?;
    let ctx = FinetuneCtx::new(store.clone(), client, unsloth_url);

    // The crate router (paths relative to `/api/finetune`) nested under the external
    // prefix, with the shared-secret gate layered over the whole nest — finetune has
    // no public route. `from_fn` closes over the resolved token so no extra state
    // field is needed.
    let gated_token = token.clone();
    let finetune = Router::new()
        .nest("/api/finetune", routes(ctx))
        .layer(from_fn(move |req: Request, next: Next| {
            let expected = gated_token.clone();
            async move { require_finetune_token(req, next, expected.as_deref()).await }
        }));

    // `/health` sits OUTSIDE the gated nest so the loopback health probe succeeds
    // before auth. It asserts the store is readable (a cheap `list`) and returns no
    // job data.
    let health_store = store;
    let app = Router::new()
        .route(
            "/health",
            get(move || {
                let store = health_store.clone();
                async move { health(store).await }
            }),
        )
        .merge(finetune);

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-finetune sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Loopback health probe: asserts the store is readable (a cheap `list`) so health
/// also confirms DB readiness, not just process liveness. Un-gated and data-free.
async fn health(store: FinetuneStore) -> Response {
    match store.list().await {
        Ok(jobs) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "jobCount": jobs.len() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Shared-secret bearer gate for the proxied `/api/finetune/*` surface. Core stays
/// the auth front — it runs `require_auth`, then re-stamps `Authorization: Bearer
/// <RYU_EXT_TOKEN>` on the loopback hop — so a request that did NOT come through
/// Core (any other local process on a shared host) is rejected with 401.
///
/// **Fail-closed:** `expected == None`/empty (no token configured) rejects every
/// request rather than falling open, so a bare-run or misconfigured sidecar never
/// serves job data unauthenticated.
async fn require_finetune_token(req: Request, next: Next, expected: Option<&str>) -> Response {
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
