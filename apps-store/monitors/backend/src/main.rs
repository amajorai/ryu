//! `ryu-monitors` — the standalone, out-of-process website-monitoring sidecar.
//!
//! Runs the extracted `ryu_monitors` capability crate (the SQLite [`MonitorStore`]
//! + the [`MonitorEngine`] + the `/api/monitors/*` CRUD / run / snapshot / alert
//! surface, defined in `lib.rs` / `api.rs` / `store.rs`) as a SEPARATE PROCESS that
//! Core spawns, health-checks, and proxies to on loopback — exactly like
//! `ryu-quests` / `ryu-mail` / `ryu-teams`. The store, engine, and handlers live in
//! the crate lib; this binary is only the process shell around them, so the SAME
//! crate still compiles into Core in-process as a path dependency (no code is
//! duplicated).
//!
//! The crate's [`ryu_monitors::routes`] already returns a state-baked, state-less
//! `Router<()>` whose paths are RELATIVE to `/api/monitors` (Core nested it at that
//! prefix in-process). This binary nests it under the same `/api/monitors` prefix,
//! so the external paths are byte-identical to Core's old in-process mount and the
//! generic ext-proxy forwards `/api/monitors/*` to it unchanged. That surface
//! INCLUDES `POST /api/monitors/:id/run` — the HTTP run endpoint Core's scheduler
//! calls once `JobTarget::Monitor` is decoupled from the in-process
//! `global_engine().run_monitor()`.
//!
//! SECURITY: loopback-only bind (127.0.0.1) + a shared-secret bearer gate
//! (`RYU_EXT_TOKEN`, injected by Core at spawn and presented on the health probe +
//! every proxied hop). EVERY `/api/monitors/*` route is protected. The gate is
//! FAIL-CLOSED: with no token configured every protected route rejects with 401.
//! `/health` is the ONE un-gated route (loopback probe, returns no monitor data), so
//! Core's pre-auth health check succeeds.
//!
//! Port: `RYU_MONITORS_PORT` env, default `8003`. Data dir: resolved via the inlined
//! `paths::ryu_dir` (`RYU_DIR`-env-first, injected by Core at spawn), so it opens the
//! SAME `monitors.db` the node uses.
//!
//! HOST SHIM (the sidecar's [`ryu_monitors::MonitorsHost`] + [`MonitorNotifier`]
//! impls): this crate inverts every cross-cutting Core call through the two traits.
//! In-process, Core wired these to its real machinery; out-of-process this shell
//! provides standalone implementations:
//!
//! - **Spider fetch** (`mcp_call_tool`) → a Core callback (`POST
//!   /api/host/monitors/spider`, ext-bearer authed): the Spider crawler needs Core's
//!   `McpRegistry`, which the sidecar does not host, so Core runs the tool on the
//!   sidecar's behalf and returns the JSON.
//! - **scheduler backing job** (`sync/remove_backing_job`) → STUB: Core owns the
//!   `JobTarget::Monitor` job store and reconciles jobs from the monitor list on a
//!   background loop (`apps/core/src/monitors_client.rs`), so the sidecar's writes
//!   are no-ops. `sync_backing_job` returns `Ok(())` (an `Err` would 500 every
//!   create, which propagates it).
//! - **interval validation** (`interval_is_valid`) → a pure local check (humantime
//!   duration OR a 5-field cron sanity check). Core's reconcile loop is the real
//!   scheduling authority, so an over-permissive accept just yields a monitor that
//!   never ticks — never a broken build.
//! - **alert fan-out** (`MonitorNotifier::deliver`) → a Core callback (`POST
//!   /api/host/monitors/alert`, ext-bearer authed): the kernel notification store +
//!   the unified activity feed are Core-only, so the sidecar posts each fired alert
//!   back and Core does the fan-out + records the activity item.

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
use serde_json::json;

use ryu_monitors::{routes, MonitorEngine, MonitorStore, MonitorsCtx};
use ryu_notify::NotifyTarget;

/// Default loopback port for the monitors sidecar (overridable via
/// `RYU_MONITORS_PORT`). 8003 is reserved for monitors (8002 is the learning bin).
/// Kept identical in `monitors.plugin.json`.
const DEFAULT_PORT: u16 = 8003;

/// The built-in Monitors app id (matches the `monitors.plugin.json` fixture id and
/// Core's `plugins::builtins::MONITORS_PLUGIN_ID`). Presented on the `x-ryu-plugin-id`
/// header of every host callback so Core can recompute the expected ext token.
const MONITORS_PLUGIN_ID: &str = "com.ryu.monitors";

/// The `x-ryu-plugin-id` header Core's `authenticate_sidecar` reads — mirrors
/// `apps/core/src/sidecar/ext_proxy.rs::HDR_PLUGIN_ID`.
const HDR_PLUGIN_ID: &str = "x-ryu-plugin-id";

/// Core's default loopback port (release). The sidecar prefers the injected
/// `RYU_CORE_PORT` (profile-shifted by Core); this is the last-resort fallback.
const DEFAULT_CORE_PORT: u16 = 7980;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_MONITORS_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Shared-secret bearer Core injects via the generic ext-proxy loader
    // (`RYU_EXT_TOKEN`) — the per-plugin minted secret it stamps on every proxied
    // hop + the health probe. The protected `/api/monitors/*` routes require it.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!(
            "ryu-monitors: protected /api/monitors/* routes require the injected shared-secret bearer"
        );
    } else {
        tracing::warn!(
            "ryu-monitors: no RYU_EXT_TOKEN set; protected /api/monitors/* routes are FAIL-CLOSED (reject all). Core injects this token when it spawns the sidecar."
        );
    }

    let dir = paths::ryu_dir();
    ryu_monitors::init_data_dir(dir.clone());
    let store = MonitorStore::open(dir.join("monitors.db"))?;

    // The sidecar host shim: Spider fetch + alert fan-out reach BACK into Core over
    // loopback (ext-bearer authed callbacks); the scheduler backing job is stubbed
    // (Core reconciles). Both callbacks share the resolved Core base URL + the
    // injected ext bearer.
    let callback = Arc::new(CoreCallback::new());
    let host: Arc<dyn ryu_monitors::MonitorsHost> = callback.clone();
    let notifier: Arc<dyn ryu_monitors::MonitorNotifier> = callback;
    let engine = MonitorEngine::new(store.clone(), host, notifier, reqwest::Client::new());

    // Publish the process-global engine for parity with the in-process wiring; in
    // the sidecar its Core-side readers (the scheduler) do not run, so it is an
    // inert-but-harmless consumer — the HTTP handlers use the state-baked
    // `MonitorsCtx` below.
    ryu_monitors::set_global_engine(engine.clone());

    // The crate router (paths relative to `/api/monitors`) nested under the external
    // prefix, with the shared-secret gate layered over the whole nest — monitors has
    // no public route. `from_fn` closes over the resolved token so no extra state
    // field is needed.
    let gated_token = token.clone();
    let monitors = Router::new()
        .nest("/api/monitors", routes(MonitorsCtx::new(engine)))
        .layer(from_fn(move |req: Request, next: Next| {
            let expected = gated_token.clone();
            async move { require_monitors_token(req, next, expected.as_deref()).await }
        }));

    // `/health` sits OUTSIDE the gated nest so the loopback health probe succeeds
    // before auth. It asserts the store is readable (a cheap `list`) and returns no
    // monitor data.
    let health_store = store;
    let app = Router::new()
        .route(
            "/health",
            get(move || {
                let store = health_store.clone();
                async move { health(store).await }
            }),
        )
        .merge(monitors);

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-monitors sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Loopback health probe: asserts the store is readable (a cheap `list`) so health
/// also confirms DB readiness, not just process liveness. Un-gated and data-free.
async fn health(store: MonitorStore) -> Response {
    match store.list_monitors().await {
        Ok(monitors) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "monitorCount": monitors.len() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Shared-secret bearer gate for the proxied `/api/monitors/*` surface. Core stays
/// the auth front — it runs `require_auth`, then re-stamps `Authorization: Bearer
/// <RYU_EXT_TOKEN>` on the loopback hop — so a request that did NOT come through Core
/// (any other local process on a shared host) is rejected with 401.
///
/// **Fail-closed:** `expected == None`/empty (no token configured) rejects every
/// request rather than falling open.
async fn require_monitors_token(req: Request, next: Next, expected: Option<&str>) -> Response {
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

/// The sidecar's standalone [`ryu_monitors::MonitorsHost`] + [`MonitorNotifier`]:
/// everything the moved monitor code needs from the host, provided by the process
/// itself (via Core callbacks) rather than by an in-process `ServerState`.
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

    /// POST a JSON body to a Core host-callback path with the ext-bearer + plugin-id
    /// headers `authenticate_sidecar` expects. Returns the parsed JSON body on 2xx.
    async fn post(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        let token = self
            .ext_token
            .as_deref()
            .ok_or_else(|| "no RYU_EXT_TOKEN configured for Core callback".to_string())?;
        let resp = self
            .http
            .post(format!("{}{path}", self.core_base))
            .bearer_auth(token)
            .header(HDR_PLUGIN_ID, MONITORS_PLUGIN_ID)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("core callback not reachable: {e}"))?;
        let status = resp.status();
        let parsed: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        if status.is_success() {
            Ok(parsed)
        } else {
            Err(parsed
                .get("error")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("core callback failed: HTTP {status}")))
        }
    }
}

#[async_trait]
impl ryu_monitors::MonitorsHost for CoreCallback {
    async fn mcp_call_tool(
        &self,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        // Spider fetch reaches Core's `McpRegistry`, which the sidecar does not host.
        // Core runs the tool on our behalf and returns its JSON result verbatim.
        let body = json!({ "tool": tool, "args": args });
        let out = self.post("/api/host/monitors/spider", body).await?;
        // Core wraps the tool result under `result`; unwrap it so the crate's
        // `spider_body_text` sees the same shape the in-process registry returned.
        Ok(out.get("result").cloned().unwrap_or(out))
    }

    fn sync_backing_job(
        &self,
        _monitor_id: &str,
        _name: &str,
        _interval: &str,
        _enabled: bool,
    ) -> Result<(), String> {
        // STUB: Core owns the `JobTarget::Monitor` job store and reconciles jobs from
        // the monitor list on a background loop (`monitors_client`). Must return
        // `Ok(())` (not `Err`) because `create_monitor`/`update_monitor` propagate it.
        Ok(())
    }

    fn remove_backing_job(&self, _monitor_id: &str) {
        // STUB: best-effort in the in-process host; a no-op here. Core's reconcile
        // loop removes the orphaned `monitor-<id>` job when the monitor is gone.
    }

    fn interval_is_valid(&self, interval: &str) -> bool {
        // Pure local validation (no Core callback): a humantime duration (`5m`, `1h`)
        // OR a 5-field cron sanity check. Core's reconcile loop is the real scheduling
        // authority, so an over-permissive accept only yields a never-ticking monitor.
        humantime::parse_duration(interval).is_ok() || looks_like_cron(interval)
    }
}

#[async_trait]
impl ryu_monitors::MonitorNotifier for CoreCallback {
    async fn deliver(&self, alert: &ryu_monitors::Alert, targets: &[NotifyTarget]) {
        // Post the fired alert back to Core, which fans it out through the kernel
        // notification store (per-monitor channels + global mobile push + the
        // `notification` plugin hooks) and records it on the unified activity feed.
        // Best-effort per the trait contract: log + drop on transport error.
        let body = json!({ "alert": alert, "targets": targets });
        if let Err(e) = self.post("/api/host/monitors/alert", body).await {
            tracing::warn!("ryu-monitors: alert fan-out callback failed: {e}");
        }
    }
}

/// A permissive 5-field cron sanity check (matches Core's
/// `scheduler::cron::CronSchedule::parse` field count): five whitespace-separated
/// fields, each a non-empty run of cron token chars (`0-9 * / , -`). Core re-parses
/// strictly when it schedules, so this only needs to reject obvious non-cron input.
fn looks_like_cron(expr: &str) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    fields.iter().all(|f| {
        !f.is_empty()
            && f.chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '*' | '/' | ',' | '-'))
    })
}

#[cfg(test)]
mod tests {
    use super::{bearer_ok, looks_like_cron};

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
    fn cron_sanity_accepts_five_fields_rejects_prose() {
        assert!(looks_like_cron("*/5 * * * *"));
        assert!(looks_like_cron("0 9 * * 1-5"));
        assert!(!looks_like_cron("5m"));
        assert!(!looks_like_cron("every day"));
        assert!(!looks_like_cron("* * * *")); // 4 fields
    }
}
