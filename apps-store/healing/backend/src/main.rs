//! `ryu-healing` — the standalone, out-of-process self-healing sidecar.
//!
//! Runs the extracted `ryu_healing` capability crate (the diagnose→propose engine,
//! the loop-prevention decision logic, the per-source attempt cap under `RYU_DIR`,
//! and the `/api/healing/*` HTTP surface, defined in `lib.rs` / `api.rs`) as a
//! SEPARATE PROCESS that Core spawns, health-checks, and drives on loopback — like
//! `ryu-quests` / `ryu-mail`. The engine, decision logic, and handlers all live in
//! the crate lib; this binary is only the process shell around them, so the SAME
//! crate still compiles into Core in-process as a path dependency (no duplication).
//!
//! ## What runs here vs. in Core (Design: sidecar computes, Core acts)
//! The **welded** couplings — the approvals-inbox write and the agent/workflow
//! re-run — stay in Core, because a heal proposal embeds a Core `PendingAction`
//! that Core's `ApprovalEngine` executes on approve, and the re-run reaches Core's
//! agent runner / workflow store. So this sidecar does NOT call back into Core.
//! Instead Core POSTs a failed run's context to `POST /api/healing/report-failure`;
//! the engine here runs the cap/cooldown/never-heal-a-heal decision + the Gateway
//! diagnosis (everything it can own by itself) and RETURNS a `HealVerdict` JSON;
//! Core then `apply_verdict`s it (the approvals write / re-run). Consequently the
//! host's action methods (`rerun_*`, `queue_heal_*`) are unreachable STUBS here —
//! they are only ever invoked Core-side via `apply_verdict`.
//!
//! ## HOST SHIM (the sidecar's [`ryu_healing::HealingHost`] impl)
//! - **preferences** → a JSON file under `RYU_DIR` (`healing-prefs.json`, durable
//!   across restarts), matching the in-process PreferencesStore-backed behaviour;
//! - **default diagnosis model** → env `RYU_DEFAULT_LLM_MODEL` → [`DEFAULT_DIAGNOSE_MODEL`];
//! - **attempt-cap data dir** → the inlined `paths::ryu_dir` (`RYU_DIR`-env-first);
//! - **Gateway diagnosis call** → one non-streaming `/v1/chat/completions` on env
//!   `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN` (mirroring `apps/core/src/server/mod.rs::call_side_model`);
//! - **agent/workflow re-run + approvals delivery** → STUBS (Core applies the verdict).
//!
//! SECURITY: loopback-only bind (127.0.0.1) + a shared-secret bearer gate
//! (`RYU_EXT_TOKEN`, injected by Core at spawn and presented on the health probe +
//! every proxied hop). EVERY `/api/healing/*` route is protected; the gate is
//! FAIL-CLOSED (no token → reject all). `/health` is the ONE un-gated route so
//! Core's pre-auth health check succeeds.
//!
//! Port: `RYU_HEALING_PORT` env, default `8001` (7990-7999 are taken by the
//! wave-1..3 sidecars). Data dir: `RYU_DIR`-env-first, so it opens the SAME
//! `healing-attempts.json` the node uses.

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
use serde_json::{json, Value};

use ryu_healing::{routes, HealEngine, HealingCtx, HealingHost};

/// Default loopback port for the healing sidecar (overridable via `RYU_HEALING_PORT`).
/// 8001 is free (7990 finetune · 7991 quests · 7992 clips · 7993 browser · 7994
/// teams · 7995 research · 7996 mail · 7997 dashboards · 7998 meetings · 7999
/// recipes are taken). Kept identical in `healing.plugin.json`.
const DEFAULT_PORT: u16 = 8001;

/// The bundled local default diagnosis model when no pref/env is set — mirrors
/// Core's `registry::DEFAULT_LOCAL_CHAT_MODEL_ID`. Nothing is hardcoded to a remote
/// provider; a pref/env still overrides this.
const DEFAULT_DIAGNOSE_MODEL: &str = "gemma-4-E2B-it-Q4_K_M";

/// Fallback local gateway URL when `RYU_GATEWAY_URL` is unset — mirrors
/// `apps/core/src/sidecar/gateway.rs`.
const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:7981";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_HEALING_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Shared-secret bearer Core injects via the generic ext-proxy loader
    // (`RYU_EXT_TOKEN`) — presented on every proxied hop + the health probe. The
    // protected `/api/healing/*` routes require it.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!(
            "ryu-healing: protected /api/healing/* routes require the injected shared-secret bearer"
        );
    } else {
        tracing::warn!(
            "ryu-healing: no RYU_EXT_TOKEN set; protected /api/healing/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }

    let dir = paths::ryu_dir();
    // ONE host instance, shared by the engine and the router's `/config` handlers.
    // `SidecarHealingHost` caches prefs in an in-memory `Mutex<HashMap>`; a second
    // instance would have its OWN cache, so a `POST /config {enabled:false}` through
    // the router would flip the router's copy while the engine's `evaluate` kept
    // reading the stale copy — the config change would not reach the loop until a
    // restart. Sharing the Arc makes `pref_set` and `evaluate` read one map.
    let host: Arc<dyn HealingHost> =
        Arc::new(SidecarHealingHost::new(dir.join("healing-prefs.json")));
    let engine = HealEngine::new(host.clone());

    // Publish the process-global engine: `GET /api/healing/status` and
    // `POST /api/healing/report-failure` read it (the crate handlers use
    // `global_engine()`, not the state-baked ctx, for the attempt map + evaluation).
    ryu_healing::set_global_engine(engine.clone());

    // The crate router (paths relative to `/api/healing`) nested under the external
    // prefix, with the shared-secret gate layered over the whole nest — healing has
    // no public route. `from_fn` closes over the resolved token so no extra state
    // field is needed. The state-baked ctx backs `/config` (pref read/write) and
    // shares the engine's host so a live config change reaches `evaluate`.
    let ctx = HealingCtx::new(host);
    let gated_token = token.clone();
    let healing = Router::new()
        .nest("/api/healing", routes(ctx))
        .layer(from_fn(move |req: Request, next: Next| {
            let expected = gated_token.clone();
            async move { require_healing_token(req, next, expected.as_deref()).await }
        }));

    // `/health` sits OUTSIDE the gated nest so the loopback health probe succeeds
    // before auth. It returns process liveness only (no heal data).
    let app = Router::new()
        .route("/health", get(health))
        .merge(healing);

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-healing sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Loopback health probe: process liveness. Un-gated and data-free.
async fn health() -> Response {
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

/// Shared-secret bearer gate for the proxied `/api/healing/*` surface. Core stays
/// the auth front — it runs `require_auth`, then re-stamps `Authorization: Bearer
/// <RYU_EXT_TOKEN>` on the loopback hop — so a request that did NOT come through Core
/// is rejected with 401. **Fail-closed:** `expected == None`/empty rejects every
/// request rather than falling open.
async fn require_healing_token(req: Request, next: Next, expected: Option<&str>) -> Response {
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

/// The sidecar's standalone [`HealingHost`]: everything the moved heal engine needs
/// from the host, provided by the process itself rather than by Core.
///
/// - **preferences** → a JSON map persisted under `RYU_DIR` (durable across restarts);
/// - **default diagnosis model** → env `RYU_DEFAULT_LLM_MODEL` → [`DEFAULT_DIAGNOSE_MODEL`];
/// - **Gateway diagnosis** → env `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN`;
/// - **agent/workflow re-run + approvals delivery** → STUBS: Core applies the
///   returned `HealVerdict` (it owns the approvals write + the re-run), so these are
///   never invoked in the sidecar. They log if ever reached (a contract violation).
struct SidecarHealingHost {
    prefs_path: PathBuf,
    prefs: Mutex<HashMap<String, String>>,
    http: reqwest::Client,
}

impl SidecarHealingHost {
    fn new(prefs_path: PathBuf) -> Self {
        let prefs = load_prefs(&prefs_path);
        Self {
            prefs_path,
            prefs: Mutex::new(prefs),
            http: reqwest::Client::new(),
        }
    }
}

/// Read the persisted preference map (empty on missing/corrupt file — a fresh
/// install just falls back to the resolver defaults).
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
impl HealingHost for SidecarHealingHost {
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

    fn default_diagnose_model(&self) -> String {
        std::env::var("RYU_DEFAULT_LLM_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_DIAGNOSE_MODEL.to_string())
    }

    fn data_dir(&self) -> PathBuf {
        paths::ryu_dir()
    }

    async fn call_side_model(
        &self,
        model: &str,
        effort: &str,
        system: &str,
        user: &str,
    ) -> Result<String, String> {
        // One non-streaming Gateway completion — byte-for-byte the request
        // `apps/core/src/server/mod.rs::call_side_model` builds, so a diagnosis is
        // firewalled / DLP'd / budgeted / audited exactly as in-process.
        let base = std::env::var("RYU_GATEWAY_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_string());
        let base = base.trim_end_matches('/');
        let mut payload = json!({
            "model": model,
            "stream": false,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
        });
        let effort = effort.trim();
        if !effort.is_empty() {
            payload["reasoning_effort"] = json!(effort);
        }
        let mut req = self
            .http
            .post(format!("{base}/v1/chat/completions"))
            .timeout(std::time::Duration::from_secs(60))
            .json(&payload);
        if let Some(t) = std::env::var("RYU_GATEWAY_TOKEN")
            .ok()
            .filter(|s| !s.is_empty())
        {
            req = req.bearer_auth(t);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("gateway unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("gateway returned HTTP {}", resp.status()));
        }
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("response was not valid JSON: {e}"))?;
        let text = body
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        Ok(text.to_string())
    }

    async fn rerun_agent(&self, _agent_id: Option<String>, _run_id: String, _prompt: String) {
        // STUB: Core applies the `HealVerdict::RerunAgent` (it owns the agent
        // runner). Never invoked in the sidecar — the engine returns the verdict.
        tracing::error!("ryu-healing: rerun_agent reached the sidecar host (contract violation)");
    }

    async fn rerun_workflow(&self, _source_id: &str) {
        tracing::error!("ryu-healing: rerun_workflow reached the sidecar host (contract violation)");
    }

    async fn queue_heal_fix(
        &self,
        _source_id: &str,
        _agent_id: Option<String>,
        _diagnosis: &str,
        _corrected: String,
    ) {
        tracing::error!("ryu-healing: queue_heal_fix reached the sidecar host (contract violation)");
    }

    async fn queue_heal_workflow(&self, _source_id: &str, _diagnosis: &str) {
        tracing::error!(
            "ryu-healing: queue_heal_workflow reached the sidecar host (contract violation)"
        );
    }

    async fn queue_heal_exhausted(&self, _source_id: &str, _note: &str) {
        tracing::error!(
            "ryu-healing: queue_heal_exhausted reached the sidecar host (contract violation)"
        );
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
        assert!(!bearer_ok(Some("secret"), None));
        assert!(!bearer_ok(Some(""), Some("")));
        assert!(!bearer_ok(None, None));
    }

    #[test]
    fn prefs_roundtrip_through_file() {
        let dir = std::env::temp_dir().join(format!("ryu-healing-test-{}", std::process::id()));
        let path = dir.join("healing-prefs.json");
        let _ = std::fs::remove_file(&path);

        assert!(load_prefs(&path).is_empty());

        let mut map = HashMap::new();
        map.insert("healing.enabled".to_string(), "false".to_string());
        save_prefs(&path, &map).expect("save prefs");

        let reloaded = load_prefs(&path);
        assert_eq!(
            reloaded.get("healing.enabled").map(String::as_str),
            Some("false")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
