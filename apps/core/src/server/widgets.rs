//! Ryu Apps widget instances + governed widget routes (U4).
//!
//! Three responsibilities:
//! 1. [`WidgetInstanceStore`] — the authoritative, per-render identity record a
//!    minted widget carries. Minting enforces the per-session concurrency cap
//!    (D4). The MCP bridge mints at emit time; the governed routes resolve.
//! 2. `POST /api/widgets/tools/call` — the **provenance gate** (Core identity)
//!    then forward to the Gateway `POST /v1/exec/tool` which owns scan → budget →
//!    forward → audit (D5). Core never decides policy inline.
//! 3. `POST /api/widgets/follow-up` — provenance gate + firewall/DLP scan +
//!    audit, then return the provenance-tagged user turn for injection.
//! 4. `POST /api/widgets/state` — persist `widgetState` server-side (D4) so it
//!    survives reload.
//!
//! Placement (AGENTS.md §1): executing the tool / injecting a turn = Core;
//! allowlist·firewall·budget·audit = Gateway. Provenance (which widget may speak
//! for which server/session) is a Core identity gate that runs *before* the
//! Gateway policy check.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;

/// How long a minted widget instance stays valid.
const WIDGET_TTL: Duration = Duration::from_secs(60 * 60 * 6);

/// Default per-session concurrency cap (mirrors the Gateway `[widget]`
/// `max_concurrent_instances_per_session`, enforced here at mint time — D4).
const DEFAULT_MAX_CONCURRENT: usize = 8;

/// One minted widget instance: the round-trip identity a widget echoes on every
/// RPC. `agent_id` / `origin_server` are server-resolved and never client-supplied.
#[derive(Debug, Clone)]
pub struct WidgetInstance {
    pub instance_id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub origin_server: String,
    /// Tools on `origin_server` a mounted widget may `callTool` (widgetAccessible).
    pub widget_accessible_tool_ids: Vec<String>,
    pub created_at: Instant,
    /// Server-side authoritative `widgetState` snapshot (D4).
    pub widget_state: Option<Value>,
}

impl WidgetInstance {
    fn is_live(&self) -> bool {
        self.created_at.elapsed() < WIDGET_TTL
    }
}

/// Process-global widget instance store. Minted by the bridge at emit time,
/// resolved by the governed routes.
pub struct WidgetInstanceStore {
    inner: Mutex<HashMap<String, WidgetInstance>>,
    max_concurrent: usize,
}

impl WidgetInstanceStore {
    fn new(max_concurrent: usize) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            max_concurrent,
        }
    }

    /// Mint a new instance, enforcing the per-session concurrency cap (D4). Over
    /// cap → `None` (no widget part is emitted; the tool still returns text).
    pub fn mint(
        &self,
        conversation_id: String,
        agent_id: String,
        origin_server: String,
        widget_accessible_tool_ids: Vec<String>,
    ) -> Option<WidgetInstance> {
        let mut map = self.inner.lock().ok()?;
        // Evict expired instances opportunistically.
        map.retain(|_, v| v.is_live());
        let live_for_session = map
            .values()
            .filter(|v| v.conversation_id == conversation_id)
            .count();
        if live_for_session >= self.max_concurrent {
            tracing::warn!(
                "widget instance cap reached for session '{conversation_id}' ({}); no widget emitted",
                self.max_concurrent
            );
            return None;
        }
        let instance_id = gen_instance_id();
        let instance = WidgetInstance {
            instance_id: instance_id.clone(),
            conversation_id,
            agent_id,
            origin_server,
            widget_accessible_tool_ids,
            created_at: Instant::now(),
            widget_state: None,
        };
        map.insert(instance_id, instance.clone());
        Some(instance)
    }

    /// Resolve a live instance by id.
    pub fn get(&self, instance_id: &str) -> Option<WidgetInstance> {
        let map = self.inner.lock().ok()?;
        map.get(instance_id).filter(|v| v.is_live()).cloned()
    }

    /// Persist a `widgetState` snapshot for an instance (D4). No-op for an
    /// unknown/expired instance.
    pub fn set_state(&self, instance_id: &str, state: Value) {
        if let Ok(mut map) = self.inner.lock() {
            if let Some(inst) = map.get_mut(instance_id) {
                inst.widget_state = Some(state);
            }
        }
    }
}

fn gen_instance_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("wgt_{n:x}{c:x}")
}

static STORE: OnceLock<WidgetInstanceStore> = OnceLock::new();

/// The process-global widget instance store.
pub fn store() -> &'static WidgetInstanceStore {
    STORE.get_or_init(|| WidgetInstanceStore::new(DEFAULT_MAX_CONCURRENT))
}

/// Mint a widget instance from the emit path (the MCP bridge). Returns the
/// minted record, or `None` when the per-session cap is hit.
pub fn mint_widget_instance(
    conversation_id: String,
    agent_id: String,
    origin_server: String,
    widget_accessible_tool_ids: Vec<String>,
) -> Option<WidgetInstance> {
    store().mint(
        conversation_id,
        agent_id,
        origin_server,
        widget_accessible_tool_ids,
    )
}

// ── POST /api/widgets/tools/call ─────────────────────────────────────────────

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

/// Error reply codes (D6): `denied | not_found | over_budget | server_error |
/// invalid_args`.
fn err_reply(status: StatusCode, code: &str, message: impl Into<String>) -> axum::response::Response {
    (
        status,
        Json(json!({ "ok": false, "error": message.into(), "code": code })),
    )
        .into_response()
}

/// `POST /api/widgets/tools/call` — provenance gate then forward to the Gateway.
pub async fn widget_call_tool(
    State(state): State<ServerState>,
    Json(body): Json<WidgetCallBody>,
) -> axum::response::Response {
    // 1. instanceId → live record (fail-closed).
    let Some(record) = store().get(&body.instance_id) else {
        return err_reply(StatusCode::NOT_FOUND, "not_found", "unknown or expired widget instance");
    };
    // 2. same-server: the tool must belong to the instance's origin server.
    let tool_server = body.tool_id.split("__").next().unwrap_or_default();
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
        .any(|t| t == &body.tool_id)
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
        &body.tool_id,
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
    let token = crate::sidecar::gateway::gateway_token();

    let mut payload = json!({
        "kind": "tool",
        "tool_id": tool_id,
        "arguments": arguments,
        "agent_id": agent_id,
        "session_id": session_id,
        "feature": feature,
    });
    if let Some((instance_id, origin_server)) = widget {
        payload["widget"] = json!({ "instance_id": instance_id, "origin_server": origin_server });
    }

    let mut req = client
        .post(&endpoint)
        .timeout(Duration::from_secs(30))
        .json(&payload);
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
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

fn allow_gateway_fallback() -> bool {
    matches!(
        std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
            .as_deref()
            .unwrap_or(""),
        "1" | "true" | "yes"
    )
}

// ── POST /api/widgets/follow-up ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WidgetFollowUpBody {
    #[serde(rename = "instanceId", alias = "instance_id")]
    instance_id: String,
    #[serde(default, rename = "toolCallId", alias = "tool_call_id")]
    tool_call_id: Option<String>,
    prompt: String,
}

/// `POST /api/widgets/follow-up` — provenance gate + firewall/DLP scan + audit,
/// then return the provenance-tagged user turn (`source:"widget"`). The desktop
/// sends the returned turn through the normal chat transport; scanning it here
/// closes the prompt-injection vector before it enters model context (R4).
pub async fn widget_follow_up(
    State(_state): State<ServerState>,
    Json(body): Json<WidgetFollowUpBody>,
) -> axum::response::Response {
    let Some(record) = store().get(&body.instance_id) else {
        return err_reply(StatusCode::NOT_FOUND, "not_found", "unknown or expired widget instance");
    };
    if body.prompt.trim().is_empty() {
        return err_reply(StatusCode::BAD_REQUEST, "invalid_args", "prompt is required");
    }

    // Firewall / PII-DLP on the prompt before it can enter model context.
    let scan = crate::sidecar::gateway::check_exec_scan(
        "widget-followup",
        &body.prompt,
        Some(&record.conversation_id),
        Some(&record.agent_id),
    )
    .await;
    if let crate::sidecar::gateway::ExecScanOutcome::Deny(reason) = scan {
        // Best-effort audit of the denial.
        crate::sidecar::gateway::report_exec_audit(
            "widget-followup",
            "follow_up",
            0,
            1,
            Some(record.conversation_id.clone()),
            Some(reason.clone()),
        )
        .await;
        return err_reply(StatusCode::FORBIDDEN, "denied", reason);
    }

    // Audit the accepted follow-up (prompt length only, never the content).
    crate::sidecar::gateway::report_exec_audit(
        "widget-followup",
        "follow_up",
        0,
        0,
        Some(record.conversation_id.clone()),
        None,
    )
    .await;

    Json(json!({
        "ok": true,
        "injected": {
            "role": "user",
            "source": "widget",
            "widget_instance_id": record.instance_id,
            "origin_server": record.origin_server,
            "conversation_id": record.conversation_id,
            "tool_call_id": body.tool_call_id,
            "prompt": body.prompt,
        }
    }))
    .into_response()
}

// ── POST /api/widgets/state ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WidgetStateBody {
    #[serde(rename = "instanceId", alias = "instance_id")]
    instance_id: String,
    state: Value,
}

/// `POST /api/widgets/state` — persist a `widgetState` snapshot server-side (D4)
/// so it survives reload. Best-effort; unknown/expired instances are a no-op.
pub async fn widget_state(
    State(_state): State<ServerState>,
    Json(body): Json<WidgetStateBody>,
) -> axum::response::Response {
    if store().get(&body.instance_id).is_none() {
        return err_reply(StatusCode::NOT_FOUND, "not_found", "unknown or expired widget instance");
    }
    store().set_state(&body.instance_id, body.state);
    Json(json!({ "ok": true })).into_response()
}

// ── Widget resource fetch (reload / third-party fallback) ────────────────────

/// `GET /api/apps/ui/:slug` — serve a built-in app's self-contained widget HTML
/// by slug (the reload / third-party fetch fallback; live widgets embed the HTML
/// in the stream part).
pub async fn apps_ui_bundle(Path(slug): Path<String>) -> axum::response::Response {
    let uri = format!("ui://widget/{slug}.html");
    match crate::sidecar::mcp::apps::read_resource(&uri) {
        Some(res) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            res.html,
        )
            .into_response(),
        None => err_reply(StatusCode::NOT_FOUND, "not_found", "unknown app widget"),
    }
}

#[derive(Debug, Deserialize)]
pub struct ResourceReadBody {
    /// The MCP server that owns the resource (in-process app namespace or a
    /// config server). Optional: when absent, only in-process apps resolve.
    #[serde(default)]
    server: Option<String>,
    uri: String,
}

/// `POST /api/mcp/resources/read` — resolve a widget resource by uri (used on
/// session reload to re-resolve `widget.html` from the resource cache).
pub async fn mcp_resources_read(
    State(state): State<ServerState>,
    Json(body): Json<ResourceReadBody>,
) -> axum::response::Response {
    // In-process apps resolve directly from the uri.
    if let Some(res) = crate::sidecar::mcp::apps::read_resource(&body.uri) {
        return Json(json!({
            "ok": true,
            "uri": res.uri,
            "mimeType": res.mime_type,
            "text": res.html,
        }))
        .into_response();
    }
    let Some(server) = body.server.as_deref().filter(|s| !s.is_empty()) else {
        return err_reply(StatusCode::NOT_FOUND, "not_found", "unknown widget resource");
    };
    match state.mcp.widget_resource(server, &body.uri).await {
        Some(res) => Json(json!({
            "ok": true,
            "uri": res.uri,
            "mimeType": res.mime_type,
            "text": res.html,
        }))
        .into_response(),
        None => err_reply(StatusCode::NOT_FOUND, "not_found", "unknown widget resource"),
    }
}
