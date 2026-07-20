//! `ryu-learning` — the standalone, out-of-process continual-learning sidecar.
//!
//! Runs the extracted `ryu_learning` capability crate (the SQLite
//! [`ExperienceStore`], the MetaClaw-style learning engine, and the `/api/learn/*`
//! + `/api/experience/list` HTTP surface) as a SEPARATE PROCESS that Core spawns,
//! health-checks, and proxies to on loopback — the same process shell every other
//! extracted app uses.
//!
//! SCAFFOLDING STATUS (important): the learning loop is welded to Core-owned kernel
//! subsystems it cannot reach from a separate process — the conversation store (to
//! sweep chats into the experience buffer), the RAG memory + retrieval stores (the
//! thumbs-feedback sink, which stays Core-side), the approvals inbox (to propose a
//! synthesized skill), the skills registry (to hot-reload after activation), the
//! preference store (all config), and the Gateway side-model (PRM scoring + skill
//! synthesis). Out-of-process, NONE of these is reachable without a broker-back
//! HTTP surface Core does not yet expose. So [`SidecarLearningHost`] returns a
//! documented `Err` for every welded callback, and Core KEEPS SERVING `/api/learn/*`
//! IN-PROCESS. This binary exists so the crate is proven process-shell-able and the
//! out-of-process decouple is unblocked the day the broker-back endpoints land.
//!
//! SECURITY: loopback-only bind (127.0.0.1) + a shared-secret bearer gate
//! (`RYU_EXT_TOKEN`, injected by Core at spawn and presented on every proxied hop).
//! EVERY `/api/learn/*` route is protected. The gate is FAIL-CLOSED: with no token
//! configured every protected route rejects with 401. `/health` is the ONE un-gated
//! route (loopback probe, returns no data), so Core's pre-auth health check
//! succeeds — mirroring `ryu-finetune`.
//!
//! Port: `RYU_LEARNING_PORT` env, default `8002`. Data dir: resolved via the inlined
//! `paths::ryu_dir` (`RYU_DIR`-env-first, injected by Core at spawn), so it opens the
//! SAME `experience.db` the node uses.

mod paths;

use std::net::{Ipv4Addr, SocketAddr};
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
use serde_json::{json, Value};

use ryu_learning::{
    routes, ConvMeta, ExperienceStore, LearningCtx, LearningHost, Msg, QueuedApproval,
};

/// Default loopback port for the learning control-plane sidecar (overridable via
/// `RYU_LEARNING_PORT`). In the free 8001-8003 band above the wave-1..3 apps
/// (finetune 7990 … recipes 7999); distinct from the Python unsloth worker (8086).
const DEFAULT_PORT: u16 = 8002;

/// The degrading [`LearningHost`] for the standalone process. Every method is a
/// callback into a Core kernel subsystem unreachable from a separate process
/// without a broker-back HTTP surface, so it fails LOUDLY (documented `Err`) rather
/// than returning a plausible-but-wrong default. Only the preference accessors are
/// harmless no-ops (returning `None`/`Ok(())`), which makes every gated engine path
/// resolve to its safe default (learning OFF) — so the surface answers rather than
/// panics, but never silently fabricates a learning result.
struct SidecarLearningHost;

const DEGRADED: &str =
    "the learning sidecar has no broker-back to Core's kernel subsystems; served in-process by Core";

#[async_trait]
impl LearningHost for SidecarLearningHost {
    async fn pref_get(&self, _key: &str) -> Option<String> {
        // No pref store out-of-process: resolvers fall back to their safe defaults
        // (learning OFF), so gated engine paths become clean no-ops.
        None
    }

    async fn pref_set(&self, _key: &str, _value: &str) -> anyhow::Result<()> {
        Ok(())
    }

    async fn list_conversations(&self) -> anyhow::Result<Vec<ConvMeta>> {
        anyhow::bail!(DEGRADED)
    }

    async fn get_messages(&self, _conversation_id: &str) -> anyhow::Result<Vec<Msg>> {
        anyhow::bail!(DEGRADED)
    }

    async fn run_side_model(
        &self,
        _model: &str,
        _effort: &str,
        _system: &str,
        _user: &str,
    ) -> Result<String, String> {
        Err(DEGRADED.to_string())
    }

    fn default_prm_model(&self) -> String {
        // A placeholder only surfaced by `GET /api/learn/config`; the real default
        // is resolved from Core's model registry in the in-process host.
        "gpt-4o-mini".to_string()
    }

    fn default_synth_model(&self) -> String {
        "gpt-4o-mini".to_string()
    }

    async fn queue_skill_approval(
        &self,
        _slug: &str,
        _name: &str,
        _description: &str,
        _conversation_id: &str,
        _skill_md: String,
    ) -> anyhow::Result<QueuedApproval> {
        anyhow::bail!(DEGRADED)
    }

    fn reload_skills(&self) {}

    async fn dispatch_finetune(&self, _body: Value) -> Result<Value, String> {
        Err(DEGRADED.to_string())
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_LEARNING_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!(
            "ryu-learning: protected /api/learn/* routes require the injected shared-secret bearer"
        );
    } else {
        tracing::warn!(
            "ryu-learning: no RYU_EXT_TOKEN set; protected /api/learn/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }
    tracing::warn!(
        "ryu-learning: SCAFFOLDING — the learning loop is welded to Core kernel subsystems and is SERVED IN-PROCESS BY CORE. This sidecar's LearningHost degrades to Err on every welded route until Core exposes broker-back endpoints."
    );

    let ryu_dir = paths::ryu_dir();
    ryu_learning::init_data_dir(ryu_dir.clone());

    let store = ExperienceStore::open_default()?;
    let host: Arc<dyn LearningHost> = Arc::new(SidecarLearningHost);
    let ctx = LearningCtx::new(store.clone(), host, reqwest::Client::new());

    // The crate router (absolute `/api/learn/*` paths) with the shared-secret gate
    // layered over the whole surface — learning has no public route.
    let gated_token = token.clone();
    let learn = routes(ctx).layer(from_fn(move |req: Request, next: Next| {
        let expected = gated_token.clone();
        async move { require_token(req, next, expected.as_deref()).await }
    }));

    // `/health` sits OUTSIDE the gated surface so the loopback health probe
    // succeeds before auth. It asserts the store is readable (a cheap `list`).
    let health_store = store;
    let app = Router::new()
        .route(
            "/health",
            get(move || {
                let store = health_store.clone();
                async move { health(store).await }
            }),
        )
        .merge(learn);

    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-learning sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Loopback health probe: asserts the store is readable so health also confirms DB
/// readiness, not just process liveness. Un-gated and data-free.
async fn health(store: ExperienceStore) -> Response {
    match store.list(1).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Shared-secret bearer gate for the proxied `/api/learn/*` surface. **Fail-closed:**
/// `expected == None`/empty rejects every request rather than falling open.
async fn require_token(req: Request, next: Next, expected: Option<&str>) -> Response {
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

/// Pure bearer check. `true` only when `expected` is a non-empty token AND
/// `provided` equals it (constant-time). A `None`/empty `expected` is fail-closed.
fn bearer_ok(provided: Option<&str>, expected: Option<&str>) -> bool {
    let Some(expected) = expected.filter(|t| !t.is_empty()) else {
        return false;
    };
    ct_eq(provided.unwrap_or("").as_bytes(), expected.as_bytes())
}

/// Constant-time byte comparison — no early return on the first mismatched byte.
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
        assert!(!bearer_ok(Some("secret"), None));
        assert!(!bearer_ok(Some(""), Some("")));
        assert!(!bearer_ok(None, None));
    }
}
