//! HTTP API for per-agent subscription usage (`GET /api/agents/:id/usage`): the
//! "usage bar" feature. Given the agent active in chat, return that agent's
//! rolling rate-limit windows (5h session + weekly) read from the CLI's own
//! local OAuth token, à la CodexBar / openusage.
//!
//! Always 200: refusals (unsupported agent, not logged in, token expired, rate
//! limited) carry `available=false` + a `reason` rather than an HTTP error, so
//! the desktop's dumb bar never branches on status codes — it just hides on
//! `unsupported` and shows a hint otherwise. All the provider logic + the
//! never-refresh token safety lives in the extracted [`ryu_usage`] crate; this
//! handler is the kernel-side route ingress that delegates to it.

use axum::{extract::Path, response::IntoResponse, Json};

/// `GET /api/agents/:id/usage` — normalized usage snapshot for one agent.
///
/// The `{id}` may be an ACP id containing a colon (`acp:claude`); clients must
/// percent-encode it (`encodeURIComponent`), which axum decodes into the single
/// `:id` segment.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/usage",
    tag = "Agents",
    summary = "Per-agent subscription usage (5h + weekly windows)",
    params(("id" = String, Path, description = "Agent id (percent-encode `acp:` ids)")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn agent_usage(Path(id): Path<String>) -> impl IntoResponse {
    Json(ryu_usage::fetch_usage(&id).await)
}
