//! The **MCP tool call** kernel capability (`mcp.callTool`).
//!
//! Runs one tool through Core's shared `McpRegistry`, which no sidecar can host (it
//! owns the stdio child processes). Body `{ tool, args }` → `{ result }`.
//!
//! Gate: the caller's minted ext token, the `tools.invoke` host grant (declared AND
//! approved), a pin to the one app this was built for (`@ryu/monitors`: Spider page
//! fetches and read-only provider-usage reads), and a fixed tool allowlist
//! ([`tool_allowed`]).
//!
//! # Why the pin stays (reviewed 2026-10-11)
//!
//! The pin was reviewed against the existing Gateway vocabulary and kept, because no
//! reviewed grant covers what this handler does. It runs `call_tool(.., None)`: no
//! verified user, no agent, no agent MCP allowlist, and no organization policy. The
//! admitted `usage.query` reads the node's sealed subscription credential or BYOK
//! key and returns subscription windows, credit balances, and the active provider
//! and model.
//!
//! - `tools.invoke` is necessary but not sufficient. Its only registry-dispatch
//!   precedent, the `tools.call` kernel capability (`server::call_tool_for_sidecar`),
//!   requires a verified caller and runs under that user's agent permission. It is
//!   also default-allowlisted, and its consent label ("Use your connected tools")
//!   describes running connected tools and managed-provider requests, not a
//!   user-less read of the node's sealed credentials. Unpinning on it alone would
//!   hand every holder a user-less read of provider usage and credits.
//! - `usage:read` does not fit either: its reviewed meaning
//!   (`plugin_host::bridge` `host.usageSnapshot`) requires a verified caller with
//!   `AGENT_VIEW` on the agent and organization availability, which a user-less
//!   sidecar call cannot satisfy.
//! - Spider fetches are network egress. An unpinned caller would fetch pages without
//!   holding `egress:http`, so any future unpin must also require it (see
//!   [`tool_allowed`]).
//!
//! Replacing the pin needs a new reviewed, user-less, per-tool scope plus consent
//! labels: a Gateway governance change, not a Core refactor. See
//! `docs/app-boundary-extraction-plan.md` (step 6) and the `KERNEL_CAPABILITIES` row in
//! `sidecar::ext_proxy`.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use super::ServerState;
use crate::plugins::builtins::MONITORS_PLUGIN_ID;
use crate::sidecar::ext_proxy::authenticate_sidecar;

/// `POST /api/host/capability/mcp.callTool` — run an allowlisted tool through
/// Core's shared MCP registry on the pinned app's behalf.
///
/// The `@ryu/monitors` pin is the load-bearing gate, not a placeholder: the broker
/// has already checked `tools.invoke` (declared∩approved) before dispatch, but that
/// grant does not cover a user-less registry call (see the module doc). The handler
/// re-checks the grant as defense in depth.
pub(crate) async fn host_mcp_call_tool(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let (plugin_id, grants) = match authenticate_sidecar(&state, &headers).await {
        Ok(value) => value,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    if plugin_id != MONITORS_PLUGIN_ID {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not the monitors app" })),
        )
            .into_response();
    }

    if !grants.contains("tools.invoke") {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "tools.invoke is not granted" })),
        )
            .into_response();
    }

    let tool = body.get("tool").and_then(Value::as_str).unwrap_or("");
    if !tool_allowed(tool) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "monitors may invoke only spider.crawl, usage.query, or usage.providers"
            })),
        )
            .into_response();
    }
    let args = body.get("args").cloned().unwrap_or(Value::Null);

    match state.mcp.call_tool(tool, args, None).await {
        Ok(result) => Json(json!({ "result": result })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// The exact tools the pinned caller may run.
///
/// If the `@ryu/monitors` pin is ever removed, `spider.crawl` must additionally
/// require the caller to hold `egress:http` (declared∩approved): today the pin is
/// what stops an arbitrary `tools.invoke` holder from fetching pages through Spider.
fn tool_allowed(tool: &str) -> bool {
    matches!(tool, "spider.crawl" | "usage.query" | "usage.providers")
}

#[cfg(test)]
mod tests {
    use super::tool_allowed;

    #[test]
    fn monitors_can_only_read_provider_usage_and_fetch_spider_pages() {
        for allowed in ["spider.crawl", "usage.query", "usage.providers"] {
            assert!(tool_allowed(allowed), "{allowed} should be allowed");
        }
        for denied in [
            "usage.current",
            "channel.send",
            "notify.desktop",
            "shell.exec",
        ] {
            assert!(!tool_allowed(denied), "{denied} should be denied");
        }
    }
}
