//! Autoresearch data path — proxies `/api/research/*` to the research sidecar.
//!
//! The sidecar (`apps-store/research/sidecar`, Python stdlib HTTP on :8087) owns
//! the git-versioned experiment workspaces + run/ledger machinery; this module is
//! a thin proxy that forwards JSON to it, plus a `status` endpoint that reports
//! install/run state and mirrors the sidecar's experiment catalog.
//!
//! Per the Core-vs-Gateway rule this is **Core** — it decides *what runs* (which
//! experiment, in which workspace). The researcher agent's own model calls stay
//! Gateway-governed. The same sidecar calls are also exposed as `research__*`
//! MCP tools ([`crate::dispatch`]) so workflow `agent`/`tool` nodes drive the loop.
//!
//! The router is built with its own state ([`ResearchCtx`]) inside this crate so it
//! returns a state-less, mergeable `Router<()>`. Routes are declared relative to
//! `/api/research` (Core nests this service at that prefix behind the Research-App
//! gate), while the OpenAPI annotations keep the full external paths.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::ResearchHost;

/// Router state for the research HTTP surface: the [`ResearchHost`] that lazily
/// starts the Core-managed sidecar and reports its install state. Cloneable so the
/// router bakes a concrete state and returns `Router<()>`.
#[derive(Clone)]
pub struct ResearchCtx {
    host: Arc<dyn ResearchHost>,
}

impl ResearchCtx {
    pub fn new(host: Arc<dyn ResearchHost>) -> Self {
        Self { host }
    }
}

/// Build the `/api/research/*` router with its own state baked in, returning a
/// state-less `Router<()>` the host nests at `/api/research` behind the App gate.
pub fn routes(ctx: ResearchCtx) -> Router<()> {
    Router::new()
        .route("/status", get(research_status))
        .route("/workspace", post(research_init_workspace))
        .route("/workspace/:id/ledger", get(research_ledger))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the research surface, merged into Core's spec when
/// the `research` feature is enabled.
pub fn openapi() -> utoipa::openapi::OpenApi {
    <ResearchApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(research_init_workspace, research_ledger, research_status))]
struct ResearchApiDoc;

/// Runs can be long, but these proxied calls (status/init/ledger) are quick.
/// A generous-but-bounded client keeps a hung sidecar from wedging the request.
fn research_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("ryu-core/0.1")
        .timeout(Duration::from_secs(30))
        .build()
        .expect("reqwest client")
}

/// `GET /api/research/status` — report install/run state and the sidecar's
/// experiment catalog. `running` is `false` (and `experiments` empty) when the
/// sidecar is not answering; never force-starts it.
#[utoipa::path(
    get,
    path = "/api/research/status",
    tag = "Research",
    summary = "report install/run state and the sidecar's",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn research_status(State(ctx): State<ResearchCtx>) -> impl IntoResponse {
    let client = research_client();
    let installed = ctx.host.is_installed();
    let running = crate::is_running_now(&client).await;

    let experiments = if running {
        match client
            .get(format!("{}/experiments", crate::research_base_url()))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => resp
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("experiments").cloned())
                .unwrap_or_else(|| json!([])),
            _ => json!([]),
        }
    } else {
        json!([])
    };

    Json(json!({
        "installed": installed,
        "running": running,
        "experiments": experiments,
    }))
}

/// `POST /api/research/workspace` — init a new experiment workspace. Lazily
/// starts the (off-by-default) sidecar so the flow works once installed, then
/// proxies to the sidecar's `POST /workspace/init`.
#[utoipa::path(
    post,
    path = "/api/research/workspace",
    tag = "Research",
    summary = "init a new experiment workspace. Lazily",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn research_init_workspace(
    State(ctx): State<ResearchCtx>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Err(e) = ctx.host.start_sidecar().await {
        tracing::debug!("research lazy start skipped: {e:#}");
    }
    proxy_post("/workspace/init", body).await
}

/// `GET /api/research/workspace/:id/ledger` — proxy the sidecar's ledger read.
#[utoipa::path(
    get,
    path = "/api/research/workspace/{id}/ledger",
    tag = "Research",
    summary = "proxy the sidecar's ledger read.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn research_ledger(
    State(ctx): State<ResearchCtx>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // A ledger read is a real data request (unlike the passive `/status` poll), so
    // it wakes the idle-stopped sidecar on demand — the scale-from-zero half of the
    // Rivet-style idle-stop. Lazy-start (via the host) also refreshes the sidecar's
    // idle clock in Core, so an actively-read workspace is never reaped.
    if let Err(e) = ctx.host.start_sidecar().await {
        tracing::debug!("research lazy start skipped: {e:#}");
    }
    proxy_get(&format!("/workspace/{id}/ledger")).await
}

/// Forward a JSON body to a sidecar endpoint and pass the response through.
async fn proxy_post(endpoint: &str, body: Value) -> (StatusCode, Json<Value>) {
    let url = format!("{}{endpoint}", crate::research_base_url());
    let resp = match research_client().post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => return unreachable_err(&url, e),
    };
    pass_through(resp).await
}

/// Forward a GET to a sidecar endpoint and pass the response through.
async fn proxy_get(endpoint: &str) -> (StatusCode, Json<Value>) {
    let url = format!("{}{endpoint}", crate::research_base_url());
    let resp = match research_client().get(&url).send().await {
        Ok(r) => r,
        Err(e) => return unreachable_err(&url, e),
    };
    pass_through(resp).await
}

fn unreachable_err(url: &str, e: reqwest::Error) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "error": format!(
                "research sidecar not reachable at {url}: {e}. Install it from the Store \
                 (or run `python -m ryu_research`) first."
            )
        })),
    )
}

async fn pass_through(resp: reqwest::Response) -> (StatusCode, Json<Value>) {
    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    if !status.is_success() {
        let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return (code, Json(value));
    }
    (StatusCode::OK, Json(value))
}
