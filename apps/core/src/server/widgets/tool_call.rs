//! `POST /api/widgets/tools/call` and the shared Gateway `/v1/exec/tool` sender.

use std::time::Duration;

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{err_reply, store};
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
pub struct WidgetCallBody {
    #[serde(rename = "instanceId", alias = "instance_id")]
    instance_id: String,
    /// Fully-qualified tool id the widget wants to call. Accepts several key
    /// spellings the desktop may use (`name`/`toolId`/`tool_id`).
    #[serde(alias = "toolId", alias = "tool_id", alias = "name")]
    tool_id: String,
    #[serde(default, alias = "arguments")]
    args: Value,
}

/// `POST /api/widgets/tools/call` — provenance gate then forward to the Gateway.
#[utoipa::path(
    post,
    path = "/api/widgets/tools/call",
    tag = "Widgets",
    summary = "provenance gate then forward to the Gateway.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn widget_call_tool(
    State(state): State<ServerState>,
    Json(body): Json<WidgetCallBody>,
) -> axum::response::Response {
    // 1. instanceId → live record (fail-closed).
    let Some(record) = store().get(&body.instance_id) else {
        return err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown or expired widget instance",
        );
    };
    // 2. same-server: the tool must belong to the instance's origin server.
    let normalized_tool_id = state.mcp.canonical_tool_id_for_registry(&body.tool_id);
    let tool_server = state
        .mcp
        .split_registered_tool_id(&normalized_tool_id)
        .map(|(server, _)| server)
        .unwrap_or_default();
    if tool_server != record.origin_server {
        return err_reply(
            StatusCode::FORBIDDEN,
            "denied",
            "tool does not belong to this widget's origin server",
        );
    }
    // 3. widgetAccessible: the tool must be a declared call target.
    if !record
        .widget_accessible_tool_ids
        .iter()
        .any(|t| t == &normalized_tool_id)
    {
        return err_reply(
            StatusCode::FORBIDDEN,
            "denied",
            "tool is not widget-accessible",
        );
    }
    // 4. agent_id is the instance's, NEVER client-supplied.
    let agent_id = record.agent_id.clone();

    // Forward to the Gateway governance front (D5): scan → budget → forward →
    // audit all happen inside `/v1/exec/tool` (U8). Core never scans/budgets/audits
    // separately.
    match forward_exec_tool(
        &state.client,
        &normalized_tool_id,
        body.args,
        &agent_id,
        &record.conversation_id,
        &record.instance_id,
        &record.origin_server,
    )
    .await
    {
        Ok(output) => Json(json!({ "ok": true, "output": output })).into_response(),
        Err((code, status, msg)) => err_reply(status, code, msg),
    }
}

/// Forward a widget-initiated tool call to the Gateway `POST /v1/exec/tool` with
/// the widget envelope. Fail-closed: an unreachable Gateway denies unless
/// `RYU_ALLOW_GATEWAY_FALLBACK` is set (in which case it falls back to the bare
/// Core call path).
async fn forward_exec_tool(
    client: &reqwest::Client,
    tool_id: &str,
    arguments: Value,
    agent_id: &str,
    conversation_id: &str,
    instance_id: &str,
    origin_server: &str,
) -> Result<Value, (&'static str, StatusCode, String)> {
    send_exec_tool(
        client,
        tool_id,
        arguments,
        agent_id,
        conversation_id,
        "widget",
        Some((instance_id, origin_server)),
    )
    .await
}

/// Dispatch a chat tool-loop tool call through the Gateway `POST /v1/exec/tool`
/// front (`kind=tool`, `feature="chat"`, no widget envelope). This is the Core
/// OpenAI-compat governed chat tool loop's single dispatch path (R1 / A7). Returns
/// the full MCP tool result `Value` on success (the same shape the ACP plane sees,
/// so `build_widget_event` parses `structuredContent`/`_meta` identically), or an
/// error string suitable for feeding back to the model as tool content.
///
/// Governance status (D5): the call routes through the gateway front, and Core's
/// `call_mcp_tool` applies the per-agent allowlist + Identity Vault. However the
/// gateway's `exec_kind_tool` (`apps/gateway/src/tools/exec.rs`) is today a bare
/// forward — firewall/DLP scan, exec-budget, and exec-audit run ONLY on the
/// widget-envelope branch (`exec_widget_tool`). Fully closing D5 for the chat
/// plane requires `exec_kind_tool` to scan/budget/audit `feature="chat"` calls
/// (mirroring `exec_widget_tool`). That is a gateway-side change in a Wave-0-owned
/// file, not Unit A's — flagged for the Integrate phase. Core must NOT scan/audit
/// inline here (that would violate the no-double-scan, policy-in-Gateway rule).
pub async fn exec_chat_tool(
    client: &reqwest::Client,
    tool_id: &str,
    arguments: Value,
    agent_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<Value, String> {
    send_exec_tool(
        client,
        tool_id,
        arguments,
        agent_id.unwrap_or_default(),
        session_id.unwrap_or_default(),
        "chat",
        None,
    )
    .await
    .map_err(|(_code, _status, msg)| msg)
}

/// Shared Gateway `POST /v1/exec/tool` sender. When `widget` is `Some`, the widget
/// envelope is attached (the governed widget `callTool` chain); when `None`, it is
/// a plain governed `kind=tool` exec (the chat tool loop). Fail-closed: an
/// unreachable Gateway denies unless `RYU_ALLOW_GATEWAY_FALLBACK` is set.
async fn send_exec_tool(
    client: &reqwest::Client,
    tool_id: &str,
    arguments: Value,
    agent_id: &str,
    session_id: &str,
    feature: &str,
    widget: Option<(&str, &str)>,
) -> Result<Value, (&'static str, StatusCode, String)> {
    let base = crate::sidecar::gateway::gateway_url();
    let endpoint = format!("{}/v1/exec/tool", base.trim_end_matches('/'));
    let token = crate::sidecar::gateway::gateway_core_token();

    let mut payload = json!({
        "kind": "tool",
        "tool_id": tool_id,
        "arguments": arguments,
        "agent_id": agent_id,
        "session_id": session_id,
        // Core owns this value: the Gateway forwards it to Core's internal tool
        // route as the host-conversation context used for tenancy and vault
        // resolution. It is not derived from model tool arguments. The paired
        // process-local proof below lets Core distinguish this forward from a
        // direct node-token request.
        "host_conversation_id": (!session_id.is_empty()).then_some(session_id),
        "host_conversation_proof": (!session_id.is_empty())
            .then(|| crate::server::host_conversation_proof(session_id)),
        "feature": feature,
    });
    if let Some((instance_id, origin_server)) = widget {
        payload["widget"] = json!({ "instance_id": instance_id, "origin_server": origin_server });
    }

    let mut req = client
        .post(&endpoint)
        .timeout(tool_forward_timeout(session_id))
        .json(&payload);
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }
    // Nest the Gateway's exec spans (and Core's own dispatch behind it) under
    // the calling tool span. No-op without an exportable context.
    let mut trace_headers = reqwest::header::HeaderMap::new();
    crate::telemetry::propagation::inject_current(&mut trace_headers);
    if !trace_headers.is_empty() {
        req = req.headers(trace_headers);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            // The gateway stamps budget/firewall policy alerts onto the tool-exec
            // response head too; read + fire-and-forget deliver before the body is
            // consumed (lenient no-op when absent).
            crate::policy_alerts::dispatch_from_headers(resp.headers());
            let body: Value = resp
                .json()
                .await
                .map_err(|e| ("server_error", StatusCode::BAD_GATEWAY, e.to_string()))?;
            let ok = body.get("ok").and_then(Value::as_bool).unwrap_or(false);
            if ok {
                Ok(body.get("result").cloned().unwrap_or(Value::Null))
            } else {
                let msg = body
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("gateway denied the tool call")
                    .to_owned();
                let over_budget = msg.to_lowercase().contains("budget");
                let code = if over_budget { "over_budget" } else { "denied" };
                Err((code, StatusCode::FORBIDDEN, msg))
            }
        }
        Ok(resp) => {
            // A denied/402 exec response also carries the policy-alert stamp; read
            // it off the head before consuming the error body.
            crate::policy_alerts::dispatch_from_headers(resp.headers());
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            Err((
                "denied",
                StatusCode::FORBIDDEN,
                format!("gateway denied exec: HTTP {status}: {text}"),
            ))
        }
        Err(e) => {
            // Fail-closed unless the operator opted into fallback.
            if allow_gateway_fallback() {
                tracing::warn!(
                    "widget callTool: gateway unreachable but RYU_ALLOW_GATEWAY_FALLBACK set; \
                     falling back to the bare Core tool path"
                );
                Err((
                    "server_error",
                    StatusCode::BAD_GATEWAY,
                    format!("gateway unreachable ({e}); fallback path is desktop's responsibility"),
                ))
            } else {
                Err((
                    "denied",
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!("gateway unreachable ({e}); widget tool call denied (fail-closed)"),
                ))
            }
        }
    }
}

pub(super) fn tool_forward_timeout(conversation_id: &str) -> Duration {
    // Scoped calls can wait for a human form answer for five minutes. Keep
    // network/provider overhead bounded without extending detached calls.
    Duration::from_secs(if conversation_id.trim().is_empty() {
        30
    } else {
        360
    })
}

pub(super) fn allow_gateway_fallback() -> bool {
    matches!(
        std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
            .as_deref()
            .unwrap_or(""),
        "1" | "true" | "yes"
    )
}
