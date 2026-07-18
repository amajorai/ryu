//! `ryu-quests` — the standalone, out-of-process auto-detecting-todo sidecar.
//!
//! Runs the extracted `ryu_quests` capability crate (the SQLite [`QuestStore`] +
//! the [`QuestEngine`] + the `/api/quests/*` CRUD/detection surface, defined in
//! `lib.rs` / `api.rs`) as a SEPARATE PROCESS that Core spawns, health-checks, and
//! proxies to on loopback — exactly like `ryu-mail` / `ryu-teams`. The store,
//! engine, and handlers live in the crate lib; this binary is only the process
//! shell around them, so the SAME crate still compiles into Core in-process as a
//! path dependency (no code is duplicated).
//!
//! The crate's [`ryu_quests::routes`] already returns a state-baked, state-less
//! `Router<()>` whose paths are RELATIVE to `/api/quests` (Core nests it at that
//! prefix in-process). This binary nests it under the same `/api/quests` prefix, so
//! the external paths are byte-identical to Core's in-process mount and the generic
//! ext-proxy forwards `/api/quests/*` to it unchanged. That surface INCLUDES the
//! pre-existing `POST /api/quests/:id/judge` route — the HTTP judge endpoint Core's
//! scheduler calls once `JobTarget::Quest` is decoupled from the in-process
//! `global_engine().judge_quest()`.
//!
//! SECURITY: loopback-only bind (127.0.0.1) + a shared-secret bearer gate
//! (`RYU_EXT_TOKEN`, injected by Core at spawn and presented on the health probe +
//! every proxied hop). EVERY `/api/quests/*` route is protected. The gate is
//! FAIL-CLOSED: with no token configured every protected route rejects with 401.
//! `/health` is the ONE un-gated route (loopback probe, returns no quest data), so
//! Core's pre-auth health check succeeds.
//!
//! Port: `RYU_QUESTS_PORT` env, default `7991`. Data dir: resolved via the inlined
//! `paths::ryu_dir` (`RYU_DIR`-env-first, injected by Core at spawn), so it opens
//! the SAME `quests.db` the node uses.
//!
//! HOST SHIM (the sidecar's [`ryu_quests::QuestsHost`] impl): this crate inverts
//! every cross-cutting Core call through the host trait. In-process, Core wires
//! these to its real machinery (`apps/core/src/quests_host.rs`). Out-of-process
//! this shell provides standalone implementations for the ones the sidecar can own
//! by itself — preferences (a JSON file under `RYU_DIR`), the Gateway judge call
//! (loopback `RYU_GATEWAY_URL`), and the default judge model — while the two
//! couplings that reach BACK into Core (Shadow MCP context; the scheduler backing
//! job) are deliberately STUBBED here (`shadow_call → None`; `sync/delete_backing_job
//! → no-op`). Those are severed and re-homed by the CoreDecouple stage (which can
//! edit Core); wiring them from here would prejudge that design. Consequence: the
//! judge endpoint runs the full judging logic and owns the model/Gateway call, but
//! without Shadow evidence `gather_context` returns `None`, so a judge pass is a
//! safe no-op until CoreDecouple supplies context.

mod paths;

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

use ryu_quests::{routes, QuestEngine, QuestStore, QuestsCtx, QuestsHost};

/// Default loopback port for the quests sidecar (overridable via `RYU_QUESTS_PORT`).
/// 7991 is free (7992 clips · 7993 browser · 7994 teams · 7995 research · 7996 mail · 7997
/// dashboards are taken). Kept identical in `quests.plugin.json`.
const DEFAULT_PORT: u16 = 7991;

/// The bundled local default judge model when no pref/env is set — mirrors Core's
/// `registry::DEFAULT_LOCAL_CHAT_MODEL_ID`. Nothing is hardcoded to a remote
/// provider; a pref/env still overrides this (see [`QuestEngine::resolve_judge_model`]).
const DEFAULT_JUDGE_MODEL: &str = "gemma-4-E2B-it-Q4_K_M";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_QUESTS_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Shared-secret bearer Core injects via the generic ext-proxy loader
    // (`RYU_EXT_TOKEN`) — the per-plugin minted secret it stamps on every proxied
    // hop + the health probe. The protected `/api/quests/*` routes require it.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!(
            "ryu-quests: protected /api/quests/* routes require the injected shared-secret bearer"
        );
    } else {
        tracing::warn!(
            "ryu-quests: no RYU_EXT_TOKEN set; protected /api/quests/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }

    let dir = paths::ryu_dir();
    let store = QuestStore::open(dir.join("quests.db"))?;

    // The sidecar host shim: preferences persist to a JSON file under `RYU_DIR`
    // (so a `detection-config` change survives a sidecar restart, matching the
    // in-process PreferencesStore-backed behaviour); the Gateway judge call reads
    // `RYU_GATEWAY_URL`/`RYU_GATEWAY_TOKEN`; Shadow context + the scheduler backing
    // job are stubbed for CoreDecouple (see the module docs).
    let host: Arc<dyn QuestsHost> = Arc::new(SidecarQuestsHost::new(dir.join("quests-prefs.json")));
    let engine = QuestEngine::new(store.clone(), host, reqwest::Client::new());

    // Publish the process-global engine as instructed. In the sidecar its readers
    // (Core's scheduler + the in-process MCP quest-board widget) do not run, so it
    // is an inert-but-harmless consumer; the HTTP handlers use the state-baked
    // `QuestsCtx` below, not `global_engine()`.
    ryu_quests::set_global_engine(engine.clone());

    // The crate router (paths relative to `/api/quests`) nested under the external
    // prefix, with the shared-secret gate layered over the whole nest — quests has
    // no public route. `from_fn` closes over the resolved token so no extra state
    // field is needed.
    let gated_token = token.clone();
    let quests = Router::new()
        .nest("/api/quests", routes(QuestsCtx::new(engine)))
        .layer(from_fn(move |req: Request, next: Next| {
            let expected = gated_token.clone();
            async move { require_quests_token(req, next, expected.as_deref()).await }
        }));

    // `/health` sits OUTSIDE the gated nest so the loopback health probe succeeds
    // before auth. It asserts the store is readable (a cheap `list`) and returns no
    // quest data.
    let health_store = store;
    let app = Router::new()
        .route(
            "/health",
            get(move || {
                let store = health_store.clone();
                async move { health(store).await }
            }),
        )
        .merge(quests);

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-quests sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Loopback health probe: asserts the store is readable (a cheap `list`) so health
/// also confirms DB readiness, not just process liveness. Un-gated and data-free.
async fn health(store: QuestStore) -> Response {
    match store.list_quests().await {
        Ok(quests) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "questCount": quests.len() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Shared-secret bearer gate for the proxied `/api/quests/*` surface. Core stays the
/// auth front — it runs `require_auth`, then re-stamps `Authorization: Bearer
/// <RYU_EXT_TOKEN>` on the loopback hop — so a request that did NOT come through Core
/// (any other local process on a shared host) is rejected with 401.
///
/// **Fail-closed:** `expected == None`/empty (no token configured) rejects every
/// request rather than falling open.
async fn require_quests_token(req: Request, next: Next, expected: Option<&str>) -> Response {
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

/// The sidecar's standalone [`QuestsHost`]: everything the moved quest code needs
/// from the host, provided by the process itself rather than by Core.
///
/// - **preferences** → a JSON map persisted under `RYU_DIR` (durable across restarts);
/// - **Gateway judge call** → env `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN` (mirroring
///   `apps/core/src/sidecar/gateway.rs`, token is `None` when unset — never fabricated);
/// - **default judge model** → env `RYU_DEFAULT_LLM_MODEL` → [`DEFAULT_JUDGE_MODEL`];
/// - **Shadow context** → STUB (`None`): reaches Core's `McpRegistry`, re-homed by CoreDecouple;
/// - **scheduler backing job** → STUB (no-op `Ok(())`): writes Core's `JobTarget::Quest`,
///   re-homed by CoreDecouple. A `sync_backing_job` that returned `Err` would break
///   `create_quest` (which propagates it), so the no-op returns `Ok(())`.
struct SidecarQuestsHost {
    prefs_path: PathBuf,
    prefs: Mutex<HashMap<String, String>>,
}

impl SidecarQuestsHost {
    fn new(prefs_path: PathBuf) -> Self {
        let prefs = load_prefs(&prefs_path);
        Self {
            prefs_path,
            prefs: Mutex::new(prefs),
        }
    }
}

/// Read the persisted preference map (empty on missing/corrupt file — a fresh
/// install just falls back to defaults).
fn load_prefs(path: &PathBuf) -> HashMap<String, String> {
    let Ok(bytes) = std::fs::read(path) else {
        return HashMap::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Persist the preference map atomically (write a temp file, then rename) so a
/// crash mid-write cannot corrupt the live config file.
fn save_prefs(path: &PathBuf, map: &HashMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[async_trait]
impl QuestsHost for SidecarQuestsHost {
    async fn pref_get(&self, key: &str) -> Option<String> {
        self.prefs.lock().ok()?.get(key).cloned()
    }

    async fn pref_set(&self, key: &str, value: &str) -> Result<(), String> {
        let snapshot = {
            let mut guard = self
                .prefs
                .lock()
                .map_err(|_| "preferences lock poisoned".to_string())?;
            guard.insert(key.to_string(), value.to_string());
            guard.clone()
        };
        save_prefs(&self.prefs_path, &snapshot)
    }

    async fn shadow_call(
        &self,
        _tool: &str,
        _args: serde_json::Value,
    ) -> Option<serde_json::Value> {
        // STUB: Shadow context reaches Core's `McpRegistry`, which the sidecar does
        // not host. Returning `None` degrades gracefully — `gather_context` yields
        // no evidence, so `judge_quest` is a safe no-op. Re-homed by CoreDecouple.
        None
    }

    fn gateway_url(&self) -> String {
        // Mirrors `apps/core/src/sidecar/gateway.rs::gateway_url` (env-first, else
        // the local gateway's default release port).
        std::env::var("RYU_GATEWAY_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "http://127.0.0.1:7981".to_string())
    }

    fn gateway_token(&self) -> Option<String> {
        // Mirrors `gateway::gateway_token` exactly: `None` when unset — never the
        // fabricated `"ryu-local"` literal (that fallback is other call sites').
        std::env::var("RYU_GATEWAY_TOKEN")
            .ok()
            .filter(|s| !s.is_empty())
    }

    fn default_judge_model(&self) -> String {
        std::env::var("RYU_DEFAULT_LLM_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_JUDGE_MODEL.to_string())
    }

    fn sync_backing_job(
        &self,
        _quest_id: &str,
        _title: &str,
        _interval: &str,
        _open: bool,
    ) -> Result<(), String> {
        // STUB: writes Core's `JobTarget::Quest` scheduler job. Must return `Ok(())`
        // (not `Err`) because `create_quest` propagates this — an `Err` would 500
        // every quest creation. Re-homed by CoreDecouple.
        Ok(())
    }

    fn delete_backing_job(&self, _quest_id: &str) {
        // STUB: best-effort in the in-process host; a no-op here. Re-homed by CoreDecouple.
    }
}

#[cfg(test)]
mod tests {
    use super::{bearer_ok, load_prefs, save_prefs};
    use std::collections::HashMap;

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
    fn prefs_roundtrip_through_file() {
        let dir = std::env::temp_dir().join(format!("ryu-quests-test-{}", std::process::id()));
        let path = dir.join("quests-prefs.json");
        let _ = std::fs::remove_file(&path);

        // Missing file → empty map (fresh install falls back to defaults).
        assert!(load_prefs(&path).is_empty());

        let mut map = HashMap::new();
        map.insert("quest-detection-mode".to_string(), "off".to_string());
        save_prefs(&path, &map).expect("save prefs");

        // Reloaded map survives (the restart-durability property).
        let reloaded = load_prefs(&path);
        assert_eq!(
            reloaded.get("quest-detection-mode").map(String::as_str),
            Some("off")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
