//! `ryu-recipes` — the standalone, out-of-process recipes sidecar.
//!
//! Runs the extracted `ryu_recipes` capability crate (the `ghost-core`
//! `RecipeStore` CRUD, the replay/record engine, and the `/api/recipes/*` HTTP
//! surface defined in `api.rs`) as a SEPARATE PROCESS that Core spawns,
//! health-checks, and proxies to on loopback — exactly like `ryu-teams`. The store
//! and handlers live in the crate lib; this binary is only the process shell around
//! them, so the SAME crate still compiles INTO Core in-process as a NON-optional
//! path dependency (the workflow executor's `Recipe`/`GhostAction` nodes reach
//! `run`/`extract_mcp_json` in every build). No code is duplicated.
//!
//! The crate's [`ryu_recipes::routes`] returns a state-baked, state-less
//! `Router<()>` whose paths are RELATIVE to `/api/recipes` (Core nests it at that
//! prefix in-process). This binary nests it under the same `/api/recipes` prefix,
//! so the external paths are byte-identical to Core's in-process mount and the
//! generic ext-proxy forwards `/api/recipes/*` to it unchanged.
//!
//! ## The live-Ghost coupling is PROXIED BACK to Core (not degraded)
//! Recipes has two transports (see the crate root):
//! - **Stateless CRUD** (list / show / save / delete) reads/writes the recipe JSON
//!   files directly via `ghost-core`'s `RecipeStore`. This works FULLY in the
//!   sidecar — no host, no Core.
//! - **Replay** (`run`) and the **recording session** (`record/*`) need the LIVE
//!   ghost engine: the shared MCP registry (to call `ghost__ghost_run`) and a
//!   dedicated recording subprocess held across start..stop. Those are Core kernel
//!   machinery, inverted through the [`RecipesHost`] trait. The sidecar owns
//!   NEITHER, so it installs [`CoreCallback`] — every host method POSTs back to
//!   Core's `/api/host/recipes/*` endpoints (ext-bearer authed), where the live
//!   [`ryu_recipes::RecipesHost`] impl runs against the real ghost engine. The
//!   recording session is held in Core's process-global slot, so start..status..stop
//!   spanning separate sidecar HTTP calls all reach the SAME session — the whole
//!   `/api/recipes/*` surface (CRUD + run + record) is therefore genuinely
//!   out-of-process; only the live-ghost machinery stays kernel-side in Core.
//!
//! ## Store location: `~/.ghost/recipes`, NOT `RYU_DIR`
//! Unlike teams/mail/finetune (private SQLite DBs under `RYU_DIR`), recipes SHARES
//! `apps/ghost`'s on-disk store: `RecipeStore::open()` resolves `~/.ghost/recipes/`.
//! Routing it through `RYU_DIR` would make in-process Core and `apps/ghost` disagree
//! about where a recipe lives — and ghost is what records AND replays, so they must
//! agree. The crate deliberately hardwires `~/.ghost`; the sidecar honours it.
//!
//! SECURITY: loopback-only bind (127.0.0.1) + a shared-secret bearer gate
//! (`RYU_EXT_TOKEN`, injected by Core at spawn and presented on every proxied hop).
//! EVERY `/api/recipes/*` route is protected — recipes has NO public surface. The
//! gate is FAIL-CLOSED: with no token configured every protected route rejects with
//! 401. `/health` is the ONE un-gated route (loopback probe, returns no recipe
//! data), so Core's pre-auth health check succeeds — mirroring `ryu-teams`.
//!
//! Port: `RYU_RECIPES_PORT` env, default `7999`.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use anyhow::Result;
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
use serde_json::Value;

use ryu_recipes::{
    routes, set_global_host, RecipesCtx, RecipesHost, RecorderStarted, RecorderStatus,
    RecorderStopped,
};

/// Default loopback port for the recipes sidecar (overridable via
/// `RYU_RECIPES_PORT`). Distinct from finetune (7990), quests (7991), clips
/// (7992), browser (7993), teams (7994), research (7995), mail (7996), and
/// dashboards (7997).
const DEFAULT_PORT: u16 = 7999;

/// The built-in Recipes app id (matches the `recipes.plugin.json` fixture id and
/// Core's `plugins::builtins::RECIPES_PLUGIN_ID`). Presented on the
/// `x-ryu-plugin-id` header of every host callback so Core can recompute the
/// expected ext token.
const RECIPES_PLUGIN_ID: &str = "com.ryu.recipes";

/// The `x-ryu-plugin-id` header Core's `authenticate_sidecar` reads — mirrors
/// `apps/core/src/sidecar/ext_proxy.rs::HDR_PLUGIN_ID`.
const HDR_PLUGIN_ID: &str = "x-ryu-plugin-id";

/// Core's default loopback port (release). The sidecar prefers the injected
/// `RYU_CORE_PORT` (profile-shifted by Core); this is the last-resort fallback.
const DEFAULT_CORE_PORT: u16 = 7980;

/// The sidecar's [`RecipesHost`] — a PROXY back into Core, not a local
/// implementation. Replay (`run`) and the recording session (`record/*`) need the
/// live ghost engine: the shared MCP registry and a dedicated recording subprocess
/// held across start..stop. Both are Core kernel machinery the sidecar does not
/// own, so every method POSTs back to Core's `/api/host/recipes/*` endpoints, where
/// the real [`RecipesHost`] impl runs against the live engine. The recording
/// session is held in Core's process-global slot, so start..status..stop across
/// separate sidecar calls all reach the SAME session. The stateless CRUD surface
/// never touches the host, so it works fully in-sidecar; the live-ghost paths ride
/// this callback.
struct CoreCallback {
    /// Core's loopback base URL (`http://127.0.0.1:<RYU_CORE_PORT>`), resolved once.
    core_base: String,
    /// The injected ext bearer (`RYU_EXT_TOKEN`) presented on every callback. `None`
    /// leaves the callbacks disabled fail-closed (they will be rejected by Core).
    ext_token: Option<String>,
    http: reqwest::Client,
}

impl CoreCallback {
    fn new() -> Self {
        let core_port: u16 = std::env::var("RYU_CORE_PORT")
            .ok()
            .and_then(|p| p.trim().parse().ok())
            .unwrap_or(DEFAULT_CORE_PORT);
        let ext_token = std::env::var("RYU_EXT_TOKEN")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        Self {
            core_base: format!("http://127.0.0.1:{core_port}"),
            ext_token,
            http: reqwest::Client::new(),
        }
    }

    /// POST a JSON body to a Core host-callback path with the ext-bearer +
    /// plugin-id headers `authenticate_sidecar` expects. Returns the parsed JSON
    /// body on 2xx (Core returns the RAW trait-level result); maps a non-2xx into
    /// the error message Core surfaced.
    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let token = self
            .ext_token
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("no RYU_EXT_TOKEN configured for Core callback"))?;
        let resp = self
            .http
            .post(format!("{}{path}", self.core_base))
            .bearer_auth(token)
            .header(HDR_PLUGIN_ID, RECIPES_PLUGIN_ID)
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("core callback not reachable: {e}"))?;
        let status = resp.status();
        let parsed: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(parsed)
        } else {
            Err(anyhow::anyhow!(parsed
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!(
                    "core callback failed: HTTP {status}"
                ))))
        }
    }
}

#[async_trait]
impl RecipesHost for CoreCallback {
    async fn call_ghost_run(&self, recipe: &str, params: Value) -> Result<Value> {
        // Core returns the RAW ghost MCP `tools/call` envelope; the crate's `run()`
        // wrapper unwraps it with `extract_mcp_json` (do NOT unwrap here — that is
        // the crate's job, identical to the in-process path).
        self.post(
            "/api/host/recipes/run",
            json!({ "recipe": recipe, "params": params }),
        )
        .await
    }

    async fn recorder_start(&self, task: &str) -> Result<RecorderStarted> {
        let raw = self
            .post("/api/host/recipes/record-start", json!({ "task": task }))
            .await?;
        serde_json::from_value(raw)
            .map_err(|e| anyhow::anyhow!("malformed RecorderStarted from Core: {e}"))
    }

    async fn recorder_status(&self) -> Result<Option<RecorderStatus>> {
        let raw = self
            .post("/api/host/recipes/record-status", json!({}))
            .await?;
        serde_json::from_value(raw)
            .map_err(|e| anyhow::anyhow!("malformed RecorderStatus from Core: {e}"))
    }

    async fn recorder_stop(&self) -> Result<RecorderStopped> {
        let raw = self
            .post("/api/host/recipes/record-stop", json!({}))
            .await?;
        serde_json::from_value(raw)
            .map_err(|e| anyhow::anyhow!("malformed RecorderStopped from Core: {e}"))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_RECIPES_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Install the Core-callback host once at boot so the replay/record routes proxy
    // back to Core's `/api/host/recipes/*` (where the live ghost engine runs)
    // instead of the crate's default "recipes host not initialized". Idempotent.
    set_global_host(Arc::new(CoreCallback::new()));

    // Shared-secret bearer Core injects via the generic ext-proxy loader
    // (`RYU_EXT_TOKEN`) — the per-plugin minted secret it stamps on every proxied
    // hop + the health probe. The protected `/api/recipes/*` routes require it.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!(
            "ryu-recipes: protected /api/recipes/* routes require the injected shared-secret bearer"
        );
    } else {
        tracing::warn!(
            "ryu-recipes: no RYU_EXT_TOKEN set; protected /api/recipes/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }

    // The crate router (paths relative to `/api/recipes`) nested under the external
    // prefix, with the shared-secret gate layered over the whole nest — recipes has
    // no public route. `from_fn` closes over the resolved token so no extra state
    // field is needed.
    let gated_token = token.clone();
    let recipes = Router::new()
        .nest("/api/recipes", routes(RecipesCtx::new()))
        .layer(from_fn(move |req: Request, next: Next| {
            let expected = gated_token.clone();
            async move { require_recipes_token(req, next, expected.as_deref()).await }
        }));

    // `/health` sits OUTSIDE the gated nest so the loopback health probe succeeds
    // before auth. It asserts the recipe store is readable (a cheap `list`, which
    // `create_dir_all`s the store dir on a fresh machine → `[]`, never an error) and
    // returns no recipe data.
    let app = Router::new().route("/health", get(health)).merge(recipes);

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-recipes sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Loopback health probe: asserts the recipe store is readable (a cheap `list`) so
/// health also confirms store readiness, not just process liveness. Un-gated and
/// data-free (returns only a count).
async fn health() -> Response {
    match ryu_recipes::list() {
        Ok(recipes) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "recipeCount": recipes.len() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Shared-secret bearer gate for the proxied `/api/recipes/*` surface. Core stays
/// the auth front — it runs `require_auth`, then re-stamps `Authorization: Bearer
/// <RYU_EXT_TOKEN>` on the loopback hop — so a request that did NOT come through
/// Core (any other local process on a shared host) is rejected with 401.
///
/// **Fail-closed:** `expected == None`/empty (no token configured) rejects every
/// request rather than falling open, so a bare-run or misconfigured sidecar never
/// serves recipe data unauthenticated.
async fn require_recipes_token(req: Request, next: Next, expected: Option<&str>) -> Response {
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
    use super::*;
    use std::net::Ipv4Addr;
    use std::sync::{Mutex, MutexGuard};

    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, Uri};

    // Serialize env-mutating tests (RYU_CORE_PORT / RYU_EXT_TOKEN / GHOST_DATA_DIR
    // are process-global).
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    fn env_lock() -> MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

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

    #[test]
    fn ct_eq_compares_bytes_constant_time_semantics() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab")); // length mismatch
        assert!(ct_eq(b"", b"")); // both empty compare equal
    }

    // ── CoreCallback env parsing ──────────────────────────────────────────────

    #[test]
    fn core_callback_new_uses_defaults_without_env() {
        let _g = env_lock();
        std::env::remove_var("RYU_CORE_PORT");
        std::env::remove_var("RYU_EXT_TOKEN");
        let cb = CoreCallback::new();
        assert_eq!(cb.core_base, format!("http://127.0.0.1:{DEFAULT_CORE_PORT}"));
        assert!(cb.ext_token.is_none());
    }

    #[test]
    fn core_callback_new_reads_port_and_token_from_env() {
        let _g = env_lock();
        std::env::set_var("RYU_CORE_PORT", "  9123  ");
        std::env::set_var("RYU_EXT_TOKEN", "  tok123  ");
        let cb = CoreCallback::new();
        assert_eq!(cb.core_base, "http://127.0.0.1:9123");
        assert_eq!(cb.ext_token.as_deref(), Some("tok123"));
        std::env::remove_var("RYU_CORE_PORT");
        std::env::remove_var("RYU_EXT_TOKEN");
    }

    #[test]
    fn core_callback_new_ignores_empty_token() {
        let _g = env_lock();
        std::env::set_var("RYU_EXT_TOKEN", "   ");
        std::env::remove_var("RYU_CORE_PORT");
        let cb = CoreCallback::new();
        assert!(cb.ext_token.is_none());
        std::env::remove_var("RYU_EXT_TOKEN");
    }

    // ── CoreCallback host methods against a mock Core (loopback) ──────────────

    #[derive(Clone)]
    struct Captured {
        auth: Option<String>,
        plugin_id: Option<String>,
        path: String,
        body: Value,
    }

    #[derive(Clone)]
    struct MockState {
        status: u16,
        body: Value,
        captured: Arc<Mutex<Option<Captured>>>,
    }

    async fn mock_handler(
        uri: Uri,
        headers: HeaderMap,
        State(state): State<MockState>,
        body: Bytes,
    ) -> Response {
        let hdr = |k: &str| {
            headers
                .get(k)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        *state.captured.lock().unwrap() = Some(Captured {
            auth: hdr("authorization"),
            plugin_id: hdr(HDR_PLUGIN_ID),
            path: uri.path().to_string(),
            body: parsed,
        });
        let st = StatusCode::from_u16(state.status).unwrap_or(StatusCode::OK);
        (st, Json(state.body)).into_response()
    }

    /// Spawn a mock Core on a random loopback port that answers every path with
    /// `(status, body)` and records the last request. Returns the port + capture.
    async fn spawn_mock_core(status: u16, body: Value) -> (u16, Arc<Mutex<Option<Captured>>>) {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let captured = Arc::new(Mutex::new(None));
        let state = MockState {
            status,
            body,
            captured: captured.clone(),
        };
        let app = Router::new().fallback(mock_handler).with_state(state);
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (port, captured)
    }

    #[tokio::test]
    async fn callback_run_returns_raw_envelope_and_stamps_auth() {
        let _g = env_lock();
        let envelope = json!({ "content": [{ "type": "text", "text": "{\"ok\":1}" }] });
        let (port, captured) = spawn_mock_core(200, envelope.clone()).await;
        std::env::set_var("RYU_CORE_PORT", port.to_string());
        std::env::set_var("RYU_EXT_TOKEN", "testtok");

        let cb = CoreCallback::new();
        // call_ghost_run returns the RAW envelope verbatim (crate::run unwraps it).
        let got = cb.call_ghost_run("myrecipe", json!({ "n": 2 })).await.unwrap();
        assert_eq!(got, envelope);

        let c = captured.lock().unwrap().clone().unwrap();
        // Security: the ext bearer + plugin-id headers are stamped on the hop.
        assert_eq!(c.auth.as_deref(), Some("Bearer testtok"));
        assert_eq!(c.plugin_id.as_deref(), Some(RECIPES_PLUGIN_ID));
        assert_eq!(c.path, "/api/host/recipes/run");
        assert_eq!(c.body["recipe"], json!("myrecipe"));
        assert_eq!(c.body["params"], json!({ "n": 2 }));

        std::env::remove_var("RYU_CORE_PORT");
        std::env::remove_var("RYU_EXT_TOKEN");
    }

    #[tokio::test]
    async fn callback_recorder_start_parses_and_hits_right_path() {
        let _g = env_lock();
        let payload = json!({ "started_at": "t0", "info": { "pid": 7 } });
        let (port, captured) = spawn_mock_core(200, payload).await;
        std::env::set_var("RYU_CORE_PORT", port.to_string());
        std::env::set_var("RYU_EXT_TOKEN", "tok");

        let cb = CoreCallback::new();
        let started = cb.recorder_start("demo").await.unwrap();
        assert_eq!(started.started_at, "t0");
        assert_eq!(started.info, json!({ "pid": 7 }));

        let c = captured.lock().unwrap().clone().unwrap();
        assert_eq!(c.path, "/api/host/recipes/record-start");
        assert_eq!(c.body["task"], json!("demo"));

        std::env::remove_var("RYU_CORE_PORT");
        std::env::remove_var("RYU_EXT_TOKEN");
    }

    #[tokio::test]
    async fn callback_recorder_status_none_deserializes() {
        let _g = env_lock();
        // Core returns `null` for "no active session".
        let (port, _captured) = spawn_mock_core(200, Value::Null).await;
        std::env::set_var("RYU_CORE_PORT", port.to_string());
        std::env::set_var("RYU_EXT_TOKEN", "tok");

        let cb = CoreCallback::new();
        let status = cb.recorder_status().await.unwrap();
        assert!(status.is_none());

        std::env::remove_var("RYU_CORE_PORT");
        std::env::remove_var("RYU_EXT_TOKEN");
    }

    #[tokio::test]
    async fn callback_recorder_stop_parses() {
        let _g = env_lock();
        let payload = json!({ "task": "t", "started_at": "t0", "payload": { "events": [] } });
        let (port, _captured) = spawn_mock_core(200, payload).await;
        std::env::set_var("RYU_CORE_PORT", port.to_string());
        std::env::set_var("RYU_EXT_TOKEN", "tok");

        let cb = CoreCallback::new();
        let stopped = cb.recorder_stop().await.unwrap();
        assert_eq!(stopped.task, "t");
        assert_eq!(stopped.started_at, "t0");

        std::env::remove_var("RYU_CORE_PORT");
        std::env::remove_var("RYU_EXT_TOKEN");
    }

    #[tokio::test]
    async fn callback_surfaces_core_error_body() {
        let _g = env_lock();
        let (port, _captured) = spawn_mock_core(500, json!({ "error": "kaboom" })).await;
        std::env::set_var("RYU_CORE_PORT", port.to_string());
        std::env::set_var("RYU_EXT_TOKEN", "tok");

        let cb = CoreCallback::new();
        let err = cb.call_ghost_run("r", json!({})).await.unwrap_err().to_string();
        assert!(err.contains("kaboom"), "unexpected: {err}");

        std::env::remove_var("RYU_CORE_PORT");
        std::env::remove_var("RYU_EXT_TOKEN");
    }

    #[tokio::test]
    async fn callback_malformed_started_payload_errors() {
        let _g = env_lock();
        // Wrong shape for RecorderStarted → deserialize failure surfaced.
        let (port, _captured) = spawn_mock_core(200, json!("not an object")).await;
        std::env::set_var("RYU_CORE_PORT", port.to_string());
        std::env::set_var("RYU_EXT_TOKEN", "tok");

        let cb = CoreCallback::new();
        let err = cb.recorder_start("x").await.unwrap_err().to_string();
        assert!(err.contains("malformed RecorderStarted"), "unexpected: {err}");

        std::env::remove_var("RYU_CORE_PORT");
        std::env::remove_var("RYU_EXT_TOKEN");
    }

    #[tokio::test]
    async fn callback_post_is_fail_closed_without_token() {
        let _g = env_lock();
        std::env::remove_var("RYU_EXT_TOKEN");
        std::env::remove_var("RYU_CORE_PORT");
        let cb = CoreCallback::new();
        // No token configured → the callback refuses to send.
        let err = cb.post("/api/host/recipes/run", json!({})).await.unwrap_err().to_string();
        assert!(err.contains("no RYU_EXT_TOKEN"), "unexpected: {err}");
    }

    // ── Health probe ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn health_reports_ok_and_recipe_count() {
        let _g = env_lock();
        let base = std::env::temp_dir().join(format!("ryu-recipes-health-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::env::set_var("GHOST_DATA_DIR", &base);

        let resp = health().await;
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["ok"], json!(true));
        assert_eq!(body["recipeCount"], json!(0));

        std::env::remove_var("GHOST_DATA_DIR");
        let _ = std::fs::remove_dir_all(&base);
    }
}
