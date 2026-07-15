//! Autoresearch data path — proxies `/api/research/*` to the research sidecar.
//!
//! The sidecar (`apps/research-sidecar`, Python stdlib HTTP on :8087) owns the
//! git-versioned experiment workspaces + run/ledger machinery; this module is a
//! thin Core proxy that forwards JSON to it, plus a `status` endpoint that
//! reports install/run state and mirrors the sidecar's experiment catalog.
//!
//! Per the Core-vs-Gateway rule this is **Core** — it decides *what runs* (which
//! experiment, in which workspace). The researcher agent's own model calls stay
//! Gateway-governed. The same sidecar calls are also exposed as `research__*`
//! MCP tools (`sidecar::mcp::research`) so workflow `agent`/`tool` nodes drive
//! the loop.

use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::{json, Value};

use crate::sidecar::tools::research;

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
pub async fn research_status() -> impl IntoResponse {
    let client = research_client();
    let installed = research::is_installed();
    let running = research::is_running_now(&client).await;

    let experiments = if running {
        match client
            .get(format!("{}/experiments", research::research_base_url()))
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
    State(state): State<super::ServerState>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Err(e) = state.manager.start_sidecar("research").await {
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
pub async fn research_ledger(Path(id): Path<String>) -> impl IntoResponse {
    proxy_get(&format!("/workspace/{id}/ledger")).await
}

/// Forward a JSON body to a sidecar endpoint and pass the response through.
async fn proxy_post(endpoint: &str, body: Value) -> (StatusCode, Json<Value>) {
    let url = format!("{}{endpoint}", research::research_base_url());
    let resp = match research_client().post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => return unreachable_err(&url, e),
    };
    pass_through(resp).await
}

/// Forward a GET to a sidecar endpoint and pass the response through.
async fn proxy_get(endpoint: &str) -> (StatusCode, Json<Value>) {
    let url = format!("{}{endpoint}", research::research_base_url());
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
