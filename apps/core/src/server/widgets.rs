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
    extract::{Path, Query, State},
    http::{header, HeaderName, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
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
    /// Whether this widget may inject a follow-up turn into the conversation.
    ///
    /// Mirrors the condition that mints the frame's `ui:send_message` grant at
    /// emit time, recorded here so the SERVER can re-decide it. The desktop host
    /// already refuses `ui.sendMessage` for a frame without the capability, but
    /// that is a client-side check on a route that is reachable directly — and
    /// injecting text into the user's conversation is the one widget power that
    /// reaches the model, so it must not rest on the caller being well-behaved.
    pub may_send_follow_up: bool,
}

/// Server-only provenance recovered from a single-use follow-up ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedWidgetProvenance {
    pub source: &'static str,
    pub widget_instance_id: String,
    pub origin_server: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone)]
struct WidgetFollowUpTicket {
    token: String,
    prompt: String,
    provenance: VerifiedWidgetProvenance,
    created_at: Instant,
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
    follow_up_tickets: Mutex<HashMap<String, WidgetFollowUpTicket>>,
    max_concurrent: usize,
}

impl WidgetInstanceStore {
    fn new(max_concurrent: usize) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            follow_up_tickets: Mutex::new(HashMap::new()),
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
        may_send_follow_up: bool,
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
            may_send_follow_up,
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

    fn issue_follow_up_ticket(&self, record: &WidgetInstance, prompt: &str) -> Option<String> {
        let token = format!("wft_{}", uuid::Uuid::new_v4().simple());
        let ticket = WidgetFollowUpTicket {
            token: token.clone(),
            prompt: prompt.to_owned(),
            provenance: VerifiedWidgetProvenance {
                source: "widget",
                widget_instance_id: record.instance_id.clone(),
                origin_server: record.origin_server.clone(),
                conversation_id: record.conversation_id.clone(),
            },
            created_at: Instant::now(),
        };
        let mut tickets = self.follow_up_tickets.lock().ok()?;
        tickets.retain(|_, ticket| ticket.created_at.elapsed() < WIDGET_TTL);
        tickets.insert(token.clone(), ticket);
        Some(token)
    }

    /// Consume a ticket only after every binding check matches. A mismatch does
    /// not burn the ticket, so a delayed desktop request can still be retried on
    /// the original conversation; a successful use is strictly one-shot.
    pub fn validate_follow_up_ticket(
        &self,
        token: &str,
        conversation_id: &str,
        prompt: &str,
    ) -> Result<VerifiedWidgetProvenance, &'static str> {
        let tickets = self
            .follow_up_tickets
            .lock()
            .map_err(|_| "widget follow-up ticket store unavailable")?;
        let Some(ticket) = tickets.get(token) else {
            return Err("unknown, expired, or already-used widget follow-up ticket");
        };
        if ticket.created_at.elapsed() >= WIDGET_TTL {
            return Err("unknown, expired, or already-used widget follow-up ticket");
        }
        if ticket.token != token
            || ticket.provenance.conversation_id != conversation_id
            || ticket.prompt != prompt
        {
            return Err("widget follow-up ticket does not match this chat turn");
        }
        Ok(ticket.provenance.clone())
    }

    pub fn consume_follow_up_ticket(
        &self,
        token: &str,
        conversation_id: &str,
        prompt: &str,
    ) -> Result<VerifiedWidgetProvenance, &'static str> {
        let mut tickets = self
            .follow_up_tickets
            .lock()
            .map_err(|_| "widget follow-up ticket store unavailable")?;
        let Some(ticket) = tickets.get(token) else {
            return Err("unknown, expired, or already-used widget follow-up ticket");
        };
        if ticket.created_at.elapsed() >= WIDGET_TTL {
            tickets.remove(token);
            return Err("unknown, expired, or already-used widget follow-up ticket");
        }
        if ticket.token != token
            || ticket.provenance.conversation_id != conversation_id
            || ticket.prompt != prompt
        {
            return Err("widget follow-up ticket does not match this chat turn");
        }
        let ticket = tickets
            .remove(token)
            .expect("ticket remains present while the store lock is held");
        Ok(ticket.provenance)
    }
}

fn gen_instance_id() -> String {
    // Crypto-random (v4). The instance id is now also the capability the public
    // asset proxy authenticates against (`GET /api/widgets/asset`), so it must be
    // unguessable — a time+counter id was enumerable.
    format!("wgt_{}", uuid::Uuid::new_v4().simple())
}

static STORE: OnceLock<WidgetInstanceStore> = OnceLock::new();

/// The process-global widget instance store.
pub fn store() -> &'static WidgetInstanceStore {
    STORE.get_or_init(|| WidgetInstanceStore::new(DEFAULT_MAX_CONCURRENT))
}

pub fn consume_follow_up_ticket(
    token: &str,
    conversation_id: &str,
    prompt: &str,
) -> Result<VerifiedWidgetProvenance, &'static str> {
    store().consume_follow_up_ticket(token, conversation_id, prompt)
}

pub fn validate_follow_up_ticket(
    token: &str,
    conversation_id: &str,
    prompt: &str,
) -> Result<VerifiedWidgetProvenance, &'static str> {
    store().validate_follow_up_ticket(token, conversation_id, prompt)
}

/// Mint a widget instance from the emit path (the MCP bridge). Returns the
/// minted record, or `None` when the per-session cap is hit.
pub fn mint_widget_instance(
    conversation_id: String,
    agent_id: String,
    origin_server: String,
    widget_accessible_tool_ids: Vec<String>,
    may_send_follow_up: bool,
) -> Option<WidgetInstance> {
    store().mint(
        conversation_id,
        agent_id,
        origin_server,
        widget_accessible_tool_ids,
        may_send_follow_up,
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

/// Stable widget route error codes (D6). Keep this closed: clients branch on
/// these values, while the message remains human-readable and non-contractual.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum WidgetErrorCode {
    Denied,
    NotFound,
    OverBudget,
    ServerError,
    InvalidArgs,
}

impl WidgetErrorCode {
    fn from_wire(code: &str) -> Self {
        match code {
            "denied" => Self::Denied,
            "not_found" => Self::NotFound,
            "over_budget" => Self::OverBudget,
            "invalid_args" => Self::InvalidArgs,
            _ => Self::ServerError,
        }
    }
}

fn err_reply(
    status: StatusCode,
    code: &str,
    message: impl Into<String>,
) -> axum::response::Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": message.into(),
            "code": WidgetErrorCode::from_wire(code),
        })),
    )
        .into_response()
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
    let token = crate::sidecar::gateway::gateway_token();

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
        .timeout(Duration::from_secs(30))
        .json(&payload);
    if let Some(tok) = token {
        req = req.bearer_auth(tok);
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
#[utoipa::path(
    post,
    path = "/api/widgets/follow-up",
    tag = "Widgets",
    summary = "provenance gate + firewall/DLP scan + audit,",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn widget_follow_up(
    State(_state): State<ServerState>,
    Json(body): Json<WidgetFollowUpBody>,
) -> axum::response::Response {
    let Some(record) = store().get(&body.instance_id) else {
        return err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown or expired widget instance",
        );
    };
    if body.prompt.trim().is_empty() {
        return err_reply(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "prompt is required",
        );
    }

    // Permission, BEFORE the scan: a widget that was never granted `ui:send_message`
    // may not put words in the user's conversation, and there is no reason to run
    // its prompt through the firewall to reach the same answer. The decision was
    // made at emit time (`may_send_follow_up`) from the owning plugin's grants; this
    // is where it is enforced, because the route is reachable without going through
    // the desktop host that performs the client-side capability check.
    if !record.may_send_follow_up {
        tracing::info!(
            instance = %record.instance_id,
            server = %record.origin_server,
            "widget follow-up refused: this widget was not granted `ui:send_message`"
        );
        return err_reply(
            StatusCode::FORBIDDEN,
            "denied",
            "this widget is not allowed to send follow-up messages",
        );
    }

    // The Gateway owns the per-instance follow-up bucket. Check it before the
    // prompt scan and fail closed on a denied or unavailable governance call so
    // this route cannot bypass the configured limit.
    if let crate::sidecar::gateway::ExecBudgetOutcome::Deny(reason) =
        crate::sidecar::gateway::check_widget_followup(&record.instance_id, &record.origin_server)
            .await
    {
        let code = if reason.to_ascii_lowercase().contains("rate limit")
            || reason.to_ascii_lowercase().contains("budget")
        {
            "over_budget"
        } else {
            "server_error"
        };
        let status = if code == "over_budget" {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        // A denied follow-up must remain visible in the Gateway audit trail,
        // including rate-limit, budget, and fail-closed Gateway errors.
        crate::sidecar::gateway::report_exec_audit_with_attribution(
            "widget-followup",
            "follow_up",
            0,
            1,
            Some(record.conversation_id.clone()),
            Some(reason.clone()),
            crate::sidecar::gateway::ExecAuditAttribution {
                agent_id: Some(record.agent_id.clone()),
                feature: Some("widget".to_owned()),
                ..Default::default()
            },
        )
        .await;
        return err_reply(status, code, reason);
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
        crate::sidecar::gateway::report_exec_audit_with_attribution(
            "widget-followup",
            "follow_up",
            0,
            1,
            Some(record.conversation_id.clone()),
            Some(reason.clone()),
            crate::sidecar::gateway::ExecAuditAttribution {
                agent_id: Some(record.agent_id.clone()),
                feature: Some("widget".to_owned()),
                ..Default::default()
            },
        )
        .await;
        return err_reply(StatusCode::FORBIDDEN, "denied", reason);
    }

    // Audit the accepted follow-up (prompt length only, never the content).
    crate::sidecar::gateway::report_exec_audit_with_attribution(
        "widget-followup",
        "follow_up",
        0,
        0,
        Some(record.conversation_id.clone()),
        None,
        crate::sidecar::gateway::ExecAuditAttribution {
            agent_id: Some(record.agent_id.clone()),
            feature: Some("widget".to_owned()),
            ..Default::default()
        },
    )
    .await;

    let Some(ticket) = store().issue_follow_up_ticket(&record, &body.prompt) else {
        return err_reply(
            StatusCode::SERVICE_UNAVAILABLE,
            "server_error",
            "could not issue widget follow-up ticket",
        );
    };

    Json(json!({
        "ok": true,
        "ticket": ticket,
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

/// Maximum serialized size retained for a client-supplied widget state.
const WIDGET_STATE_MAX_BYTES: usize = 64 * 1024;
/// Maximum number of nested JSON containers retained for a widget state.
const WIDGET_STATE_MAX_DEPTH: usize = 32;

fn validate_widget_state(state: &Value) -> Result<(), &'static str> {
    let serialized = serde_json::to_vec(state).map_err(|_| "widget state is not valid JSON")?;
    if serialized.len() > WIDGET_STATE_MAX_BYTES {
        return Err("widget state exceeds the maximum serialized size");
    }

    let mut pending = vec![(state, 0usize)];
    while let Some((value, depth)) = pending.pop() {
        if depth > WIDGET_STATE_MAX_DEPTH {
            return Err("widget state exceeds the maximum nesting depth");
        }
        match value {
            Value::Array(values) => pending.extend(values.iter().map(|value| (value, depth + 1))),
            Value::Object(values) => {
                pending.extend(values.values().map(|value| (value, depth + 1)))
            }
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct WidgetStateBody {
    #[serde(rename = "instanceId", alias = "instance_id")]
    instance_id: String,
    state: Value,
}

/// `POST /api/widgets/state` — persist a `widgetState` snapshot server-side (D4)
/// so it survives reload. Best-effort; unknown/expired instances are a no-op.
#[utoipa::path(
    post,
    path = "/api/widgets/state",
    tag = "Widgets",
    summary = "persist a `widgetState` snapshot server-side (D4)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn widget_state(
    State(_state): State<ServerState>,
    Json(body): Json<WidgetStateBody>,
) -> axum::response::Response {
    if store().get(&body.instance_id).is_none() {
        return err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown or expired widget instance",
        );
    }
    if let Err(message) = validate_widget_state(&body.state) {
        return err_reply(StatusCode::BAD_REQUEST, "invalid_args", message);
    }
    store().set_state(&body.instance_id, body.state);
    Json(json!({ "ok": true })).into_response()
}

// ── GET /api/widgets/asset — governed remote-asset proxy ─────────────────────
//
// A widget renders inside a null-origin sandbox whose CSP pins `connect-src
// 'none'`: it cannot `fetch()`/beacon, and its ONLY egress channel is passive
// subresources (`<img>`, `@font-face`, `<audio>`/`<video>`) which the mount
// rewrites to point here. This proxy is therefore the single governed egress
// lane for a widget's declared remote assets (the img-src analogue of the
// governed `callTool` lane). It rides the PUBLIC router because a browser
// subresource load cannot carry the node bearer; auth is in-handler:
//
//   1. `instance` → a live minted `WidgetInstance` (the capability + provenance)
//      → the authoritative `origin_server` (never a client-supplied `server=`).
//   2. the target host MUST be in that origin server's widget-resource
//      `resource_domains` allowlist (a forged `template` can only pick another
//      allowlist ON THE SAME SERVER — it can never widen beyond it).
//   3. the shared Ryu egress primitive rejects private/loopback/link-local/metadata
//      targets even if an allowlist entry names one, and pins the resolved address.
//   4. a content-type allowlist (image/font/audio/video only) + size cap +
//      timeout, and every fetch is exec-audited so the Gateway sees the egress.

/// Max bytes proxied for a single asset (fail-closed above this).
const WIDGET_ASSET_MAX_BYTES: usize = 25 * 1024 * 1024;
/// Upstream fetch timeout for a proxied asset.
const WIDGET_ASSET_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
pub struct WidgetAssetQuery {
    /// Minted widget instance id — the capability + provenance handle. Resolves
    /// the authoritative origin server; never client-supplied server identity.
    #[serde(alias = "instanceId")]
    instance: String,
    /// The widget resource uri whose declared `resource_domains` allowlist gates
    /// this fetch. Resolved on the instance's origin server, so a forged value can
    /// only select another allowlist on the SAME server.
    #[serde(default, alias = "templateUri")]
    template: Option<String>,
    /// The absolute `https://` asset URL to proxy.
    url: String,
}

/// `GET /api/widgets/asset` — the governed remote-asset egress lane (see the
/// module comment above). Fail-closed at every step.
#[utoipa::path(
    get,
    path = "/api/widgets/asset",
    tag = "Widgets",
    summary = "governed remote-asset proxy for a sandboxed widget",
    params(
        ("instance" = String, Query, description = "minted widget instance id"),
        ("template" = Option<String>, Query, description = "widget resource uri"),
        ("url" = String, Query, description = "absolute https asset url")
    ),
    responses((status = 200, description = "asset bytes"))
)]
pub async fn widget_asset(
    State(state): State<ServerState>,
    Query(q): Query<WidgetAssetQuery>,
) -> axum::response::Response {
    // 1. instance → origin server (authoritative provenance; fail-closed).
    let Some(record) = store().get(&q.instance) else {
        return err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown or expired widget instance",
        );
    };

    // 2. Parse the target; `https://` only.
    let Ok(target) = url::Url::parse(&q.url) else {
        return err_reply(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "asset url is not a valid URL",
        );
    };
    if target.scheme() != "https" {
        return err_reply(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "asset url must be https",
        );
    }
    let Some(host) = target.host_str().map(str::to_ascii_lowercase) else {
        return err_reply(
            StatusCode::BAD_REQUEST,
            "invalid_args",
            "asset url has no host",
        );
    };

    // 3. Authoritative allowlist: the origin server's widget-resource
    //    `resource_domains`. Empty allowlist (e.g. a built-in that inlines every
    //    asset) → refuse everything.
    let allow = widget_asset_allowlist(&state, &record.origin_server, q.template.as_deref()).await;
    if !allow.iter().any(|h| h == &host) {
        return err_reply(
            StatusCode::FORBIDDEN,
            "denied",
            format!("host '{host}' is not in the widget's declared resource_domains"),
        );
    }

    // 4. Core's shared egress primitive screens the hostname, resolves every
    //    address, rejects internal ranges, pins the connection to those addresses,
    //    disables redirects, and enforces the timeout/body cap.
    let started = Instant::now();
    let resp = match ryu_egress::guarded_request(
        ryu_egress::GuardedRequest {
            method: "GET".to_owned(),
            url: target.to_string(),
            headers: vec![(
                header::ACCEPT.as_str().to_owned(),
                "image/*,font/*,audio/*,video/*,*/*;q=0.1".to_owned(),
            )],
            body: None,
        },
        ryu_egress::GuardedFetchPolicy {
            allow_http: false,
            max_body_bytes: WIDGET_ASSET_MAX_BYTES as u64,
            max_redirect_hops: 0,
            timeout: WIDGET_ASSET_TIMEOUT,
        },
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            audit_asset(&record, &host, 0, started, Some(error.clone())).await;
            let status = if error.contains("not allowed") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::BAD_GATEWAY
            };
            return err_reply(status, "denied", error);
        }
    };
    if !(200..300).contains(&resp.status) {
        let status = resp.status;
        audit_asset(
            &record,
            &host,
            0,
            started,
            Some(format!("upstream {status}")),
        )
        .await;
        return err_reply(
            StatusCode::BAD_GATEWAY,
            "server_error",
            format!("asset upstream returned {status}"),
        );
    }

    // 7. Content-type allowlist: passive media only — never html/js (a widget can
    //    never turn this lane into a remote-code loader; script-src is nonce-only
    //    regardless, so this is belt-and-suspenders).
    let content_type = resp
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(header::CONTENT_TYPE.as_str()))
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    if !content_type_is_allowed(&content_type) {
        audit_asset(
            &record,
            &host,
            0,
            started,
            Some(format!("blocked content-type {content_type}")),
        )
        .await;
        return err_reply(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "denied",
            format!("content-type '{content_type}' is not a permitted widget asset type"),
        );
    }

    // 8. The shared egress response is already bounded by the policy above.
    let bytes = resp.body;
    let n = bytes.len();
    audit_asset(&record, &host, n, started, None).await;

    // 9. Return the bytes with the real content-type. `Access-Control-Allow-Origin:
    //    *` is REQUIRED: a null-origin frame's cross-origin `@font-face` fetch is
    //    CORS-gated and silently fails without it (images are no-cors, so ACAO is a
    //    harmless no-op for them). `nosniff` + a modest cache round it out.
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".to_owned()),
            (header::CACHE_CONTROL, "public, max-age=3600".to_owned()),
            (
                HeaderName::from_static("x-content-type-options"),
                "nosniff".to_owned(),
            ),
        ],
        bytes,
    )
        .into_response()
}

/// Resolve the origin server's widget-resource `resource_domains` allowlist
/// (lowercased exact hosts). Server-scoped via `widget_resource(server, tpl)`, so
/// a client-forged `template` can only ever select another allowlist on the same
/// server. A built-in app (meta `None`) yields an empty allowlist → deny-all.
async fn widget_asset_allowlist(
    state: &ServerState,
    server: &str,
    template: Option<&str>,
) -> Vec<String> {
    let meta = match template {
        Some(tpl) => state
            .mcp
            .widget_resource(server, tpl)
            .await
            .and_then(|r| r.meta),
        None => None,
    };
    meta.as_ref()
        .map(parse_resource_domains)
        .unwrap_or_default()
}

/// Parse the `resource_domains` allowlist from a widget resource's `_meta`,
/// tolerating every spelling in the wild: top-level `resource_domains` /
/// `resourceDomains`, and the nested `openai/widgetCSP` / `ryu/widgetCSP` /
/// `ui.csp` objects. Each entry is normalized to a bare lowercase host.
pub(crate) fn parse_resource_domains(meta: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push_from = |v: Option<&Value>| {
        if let Some(arr) = v.and_then(Value::as_array) {
            for item in arr {
                if let Some(h) = item.as_str().and_then(normalize_allow_host) {
                    if !out.contains(&h) {
                        out.push(h);
                    }
                }
            }
        }
    };
    push_from(meta.get("resource_domains"));
    push_from(meta.get("resourceDomains"));
    for container in ["openai/widgetCSP", "ryu/widgetCSP"] {
        if let Some(csp) = meta.get(container) {
            push_from(csp.get("resource_domains"));
            push_from(csp.get("resourceDomains"));
        }
    }
    if let Some(csp) = meta.get("ui").and_then(|ui| ui.get("csp")) {
        push_from(csp.get("resource_domains"));
        push_from(csp.get("resourceDomains"));
    }
    out
}

/// Normalize an allowlist entry (`https://cdn.example.com`, `cdn.example.com`,
/// `cdn.example.com:443/x`) to its bare lowercase host, or `None`. Wildcards are
/// rejected (exact-host match only — fail-closed, mirroring the client sanitizer).
fn normalize_allow_host(entry: &str) -> Option<String> {
    let e = entry.trim();
    if e.is_empty() {
        return None;
    }
    let host = if e.contains("://") {
        url::Url::parse(e).ok()?.host_str()?.to_ascii_lowercase()
    } else {
        e.split('/')
            .next()?
            .split(':')
            .next()?
            .trim()
            .to_ascii_lowercase()
    };
    if host.is_empty() || host.contains('*') || !host.contains('.') {
        return None;
    }
    Some(host)
}

/// Passive-media content types only. `application/octet-stream` is permitted (CDNs
/// serve fonts/images as it) — safe because the frame's `script-src` is nonce-only,
/// so a mislabeled script can never execute regardless of what this returns.
fn content_type_is_allowed(ct: &str) -> bool {
    let m = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    m.starts_with("image/")
        || m.starts_with("font/")
        || m.starts_with("audio/")
        || m.starts_with("video/")
        || m == "application/font-woff"
        || m == "application/font-woff2"
        || m == "application/vnd.ms-fontobject"
        || m == "application/octet-stream"
}

/// Emit a Gateway exec-audit for a proxied asset fetch so every widget egress is
/// visible to the governance layer (the property the `connect-src 'none'` lock +
/// this proxy jointly provide). Best-effort; never blocks the response.
async fn audit_asset(
    record: &WidgetInstance,
    host: &str,
    bytes: usize,
    started: Instant,
    error: Option<String>,
) {
    crate::sidecar::gateway::report_exec_audit_with_attribution(
        "widget-asset",
        &format!("GET https://{host} ({bytes} bytes)"),
        started.elapsed().as_millis() as u64,
        i32::from(error.is_some()),
        Some(record.conversation_id.clone()),
        error,
        crate::sidecar::gateway::ExecAuditAttribution {
            agent_id: Some(record.agent_id.clone()),
            feature: Some("widget".to_owned()),
            ..Default::default()
        },
    )
    .await;
}

// ── Widget resource fetch (reload / third-party fallback) ────────────────────

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
#[utoipa::path(
    post,
    path = "/api/mcp/resources/read",
    tag = "MCP",
    summary = "resolve a widget resource by uri (used on",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn mcp_resources_read(
    State(state): State<ServerState>,
    Json(body): Json<ResourceReadBody>,
) -> axum::response::Response {
    let Some(server) = body.server.as_deref().filter(|s| !s.is_empty()) else {
        return err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown widget resource",
        );
    };
    match state.mcp.widget_resource(server, &body.uri).await {
        Some(res) => Json(json!({
            "ok": true,
            "uri": res.uri,
            "mimeType": res.mime_type,
            "text": res.html,
        }))
        .into_response(),
        None => err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown widget resource",
        ),
    }
}

#[cfg(test)]
mod asset_proxy_tests {
    use super::{
        content_type_is_allowed, normalize_allow_host, parse_resource_domains,
        validate_widget_state, WIDGET_STATE_MAX_BYTES, WIDGET_STATE_MAX_DEPTH,
    };
    use serde_json::{json, Value};

    #[test]
    fn normalize_accepts_public_hosts_rejects_wildcards_and_bare_labels() {
        assert_eq!(
            normalize_allow_host("https://cdn.example.com"),
            Some("cdn.example.com".to_owned())
        );
        assert_eq!(
            normalize_allow_host("cdn.example.com:443/x"),
            Some("cdn.example.com".to_owned())
        );
        assert_eq!(
            normalize_allow_host("CDN.Example.COM"),
            Some("cdn.example.com".to_owned())
        );
        // Wildcards, single-label hosts, and empties are rejected (fail-closed).
        assert_eq!(normalize_allow_host("*.example.com"), None);
        assert_eq!(normalize_allow_host("localhost"), None);
        assert_eq!(normalize_allow_host("com"), None);
        assert_eq!(normalize_allow_host("   "), None);
    }

    #[test]
    fn shared_egress_guard_blocks_private_loopback_linklocal_and_metadata() {
        // Metadata + private + loopback + link-local IPv4.
        for value in [
            "169.254.169.254",
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.1",
            "172.16.0.1",
            "0.0.0.0",
        ] {
            assert!(
                ryu_egress::is_blocked_ip(value.parse().expect("valid IP")),
                "{value}"
            );
        }
        // IPv6 loopback + ULA + link-local + IPv4-mapped private.
        for value in ["::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"] {
            assert!(
                ryu_egress::is_blocked_ip(value.parse().expect("valid IP")),
                "{value}"
            );
        }
        // Internal names.
        for value in ["localhost", "db.internal", "printer.local"] {
            assert!(ryu_egress::is_blocked_hostname(value), "{value}");
        }
        // A real public host is NOT blocked.
        assert!(!ryu_egress::is_blocked_hostname("cdn.example.com"));
        assert!(!ryu_egress::is_blocked_ip(
            "8.8.8.8".parse().expect("valid IP")
        ));
    }

    #[test]
    fn content_type_allows_media_rejects_html_and_js() {
        assert!(content_type_is_allowed("image/png"));
        assert!(content_type_is_allowed("image/svg+xml; charset=utf-8"));
        assert!(content_type_is_allowed("font/woff2"));
        assert!(content_type_is_allowed("audio/mpeg"));
        assert!(content_type_is_allowed("video/mp4"));
        assert!(content_type_is_allowed("application/octet-stream"));
        assert!(!content_type_is_allowed("text/html"));
        assert!(!content_type_is_allowed("application/javascript"));
        assert!(!content_type_is_allowed("text/javascript; charset=utf-8"));
    }

    #[test]
    fn parse_resource_domains_reads_every_spelling() {
        // Top-level snake + camel.
        let m = json!({ "resource_domains": ["https://a.example.com"], "resourceDomains": ["b.example.com"] });
        let hosts = parse_resource_domains(&m);
        assert!(hosts.contains(&"a.example.com".to_owned()));
        assert!(hosts.contains(&"b.example.com".to_owned()));

        // Nested openai/ryu widgetCSP + ui.csp.
        let m2 = json!({
            "openai/widgetCSP": { "resource_domains": ["c.example.com"] },
            "ryu/widgetCSP": { "resourceDomains": ["d.example.com"] },
            "ui": { "csp": { "resource_domains": ["e.example.com"] } },
        });
        let hosts2 = parse_resource_domains(&m2);
        for h in ["c.example.com", "d.example.com", "e.example.com"] {
            assert!(hosts2.contains(&h.to_owned()), "missing {h}");
        }

        // Wildcards dropped; no domains → empty (deny-all).
        let m3 = json!({ "resource_domains": ["*.evil.com"] });
        assert!(parse_resource_domains(&m3).is_empty());
        assert!(parse_resource_domains(&json!({})).is_empty());
    }

    use super::{
        allow_gateway_fallback, err_reply, VerifiedWidgetProvenance, WidgetErrorCode,
        WidgetInstance, WidgetInstanceStore,
    };
    use axum::http::StatusCode;

    /// Serializes the `RYU_ALLOW_GATEWAY_FALLBACK` env mutation.
    static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The per-session concurrency cap is enforced at mint: over cap → `None` (no
    /// widget part emitted, D4). A different session is unaffected by another's cap.
    #[test]
    fn mint_enforces_per_session_cap() {
        let store = WidgetInstanceStore::new(2);
        let a1 = store.mint("sess-a".into(), "ag".into(), "srv".into(), vec![], false);
        let a2 = store.mint("sess-a".into(), "ag".into(), "srv".into(), vec![], false);
        assert!(a1.is_some() && a2.is_some(), "first two in a session mint");
        // Third for the SAME session is over cap → None.
        assert!(
            store
                .mint("sess-a".into(), "ag".into(), "srv".into(), vec![], false)
                .is_none(),
            "over-cap mint must return None"
        );
        // A different session has its own budget.
        assert!(
            store
                .mint("sess-b".into(), "ag".into(), "srv".into(), vec![], false)
                .is_some(),
            "the cap is per-session, not global"
        );
    }

    /// Minted instances get unguessable, unique ids and resolve by id; an unknown id
    /// fails closed (the capability the public asset proxy authenticates against).
    #[test]
    fn mint_ids_are_unique_and_resolvable() {
        let store = WidgetInstanceStore::new(8);
        let i1 = store
            .mint(
                "s".into(),
                "ag".into(),
                "srv".into(),
                vec!["tool.x".into()],
                false,
            )
            .unwrap();
        let i2 = store
            .mint("s".into(), "ag".into(), "srv".into(), vec![], false)
            .unwrap();
        assert_ne!(i1.instance_id, i2.instance_id, "ids must be unique");
        assert!(i1.instance_id.starts_with("wgt_"));
        // Resolvable by id, carrying the server-resolved provenance.
        let got = store.get(&i1.instance_id).expect("live instance resolves");
        assert_eq!(got.origin_server, "srv");
        assert_eq!(got.widget_accessible_tool_ids, vec!["tool.x".to_owned()]);
        // Unknown id → None (fail-closed).
        assert!(store.get("wgt_does_not_exist").is_none());
    }

    /// `set_state` persists a server-authoritative snapshot for a live instance and is
    /// a silent no-op for an unknown id (never mints a phantom row).
    #[test]
    fn set_state_persists_for_live_and_noops_for_unknown() {
        let store = WidgetInstanceStore::new(8);
        let inst = store
            .mint("s".into(), "ag".into(), "srv".into(), vec![], false)
            .unwrap();
        assert!(store.get(&inst.instance_id).unwrap().widget_state.is_none());
        store.set_state(&inst.instance_id, json!({ "count": 5 }));
        assert_eq!(
            store.get(&inst.instance_id).unwrap().widget_state,
            Some(json!({ "count": 5 }))
        );
        // No-op for an unknown id — must not create a resolvable instance.
        store.set_state("wgt_ghost", json!({ "x": 1 }));
        assert!(store.get("wgt_ghost").is_none());
    }

    #[test]
    fn widget_state_accepts_size_and_depth_boundaries() {
        let state = Value::String("x".repeat(WIDGET_STATE_MAX_BYTES - 2));
        assert!(validate_widget_state(&state).is_ok());

        let mut nested = json!(null);
        for _ in 0..WIDGET_STATE_MAX_DEPTH {
            nested = json!([nested]);
        }
        assert!(validate_widget_state(&nested).is_ok());
    }

    #[test]
    fn widget_state_rejects_oversized_or_deep_state_with_stable_messages() {
        let oversized = Value::String("x".repeat(WIDGET_STATE_MAX_BYTES - 1));
        assert_eq!(
            validate_widget_state(&oversized),
            Err("widget state exceeds the maximum serialized size")
        );

        let mut too_deep = json!(null);
        for _ in 0..=WIDGET_STATE_MAX_DEPTH {
            too_deep = json!([too_deep]);
        }
        assert_eq!(
            validate_widget_state(&too_deep),
            Err("widget state exceeds the maximum nesting depth")
        );
    }

    /// The D6 error envelope is `{ ok:false, error, code }` at the given status — the
    /// shape every widget route returns on a denial / bad-args.
    #[test]
    fn err_reply_shapes_the_d6_error_envelope() {
        let resp = err_reply(StatusCode::FORBIDDEN, "denied", "nope");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    /// The shared SSRF IP guard blocks IPv4-mapped IPv6 metadata and carrier-grade
    /// NAT ranges, and passes genuine public addresses.
    #[test]
    fn ip_guard_blocks_mapped_and_ula_passes_public() {
        assert!(ryu_egress::is_blocked_ip(
            "::ffff:169.254.169.254".parse().unwrap()
        ));
        assert!(ryu_egress::is_blocked_ip("100.64.0.1".parse().unwrap()));
        assert!(!ryu_egress::is_blocked_ip("1.1.1.1".parse().unwrap()));
        assert!(!ryu_egress::is_blocked_ip(
            "2606:4700:4700::1111".parse().unwrap()
        ));
    }

    /// The gateway-fallback escape hatch is OFF unless explicitly opted in with a
    /// documented truthy token — a stray value keeps the safe default.
    #[test]
    fn gateway_fallback_is_opt_in_only() {
        let _guard = ENV_GUARD.lock().unwrap();
        let prior = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();

        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        assert!(!allow_gateway_fallback(), "unset → off");
        for on in ["1", "true", "yes"] {
            std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", on);
            assert!(allow_gateway_fallback(), "'{on}' enables fallback");
        }
        for off in ["0", "false", "", "on"] {
            std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", off);
            assert!(!allow_gateway_fallback(), "'{off}' keeps fallback off");
        }

        match prior {
            Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
            None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
        }
    }

    /// Extra `normalize_allow_host` edges: an entry with a path/port strips to the
    /// bare host; a `://`-scheme entry parses its host; an IPv6-literal-ish or
    /// dotless label is rejected.
    #[test]
    fn normalize_allow_host_strips_port_path_and_scheme() {
        assert_eq!(
            normalize_allow_host("https://cdn.example.com:8443/a/b?x=1"),
            Some("cdn.example.com".to_owned())
        );
        assert_eq!(
            normalize_allow_host("assets.example.co.uk/path"),
            Some("assets.example.co.uk".to_owned())
        );
        // Dotless single label (even non-localhost) is rejected — exact public host only.
        assert_eq!(normalize_allow_host("intranet"), None);
    }

    /// Content-type gate is case-insensitive and ignores parameters, and never
    /// permits active types (html/js/json) that could turn the lane into a loader.
    #[test]
    fn content_type_gate_is_case_and_param_insensitive() {
        assert!(content_type_is_allowed("IMAGE/PNG"));
        assert!(content_type_is_allowed("Font/WOFF2 ; charset=binary"));
        assert!(content_type_is_allowed("application/vnd.ms-fontobject"));
        assert!(!content_type_is_allowed("application/json"));
        assert!(!content_type_is_allowed(""));
        assert!(!content_type_is_allowed("text/html; charset=utf-8"));
    }

    fn mint(store: &WidgetInstanceStore, may_send_follow_up: bool) -> WidgetInstance {
        store
            .mint(
                "conv1".to_owned(),
                "agent1".to_owned(),
                "srv".to_owned(),
                vec![],
                may_send_follow_up,
            )
            .expect("under the per-session cap")
    }

    /// The follow-up permission must survive the round-trip from emit to the
    /// governed route, because that route is where it is enforced. If the flag
    /// were dropped on the way into the store, `widget_follow_up` would read
    /// `false` for every widget and silently refuse all of them — or, had the
    /// default gone the other way, allow all of them.
    #[test]
    fn follow_up_permission_round_trips_through_the_instance_store() {
        let store = WidgetInstanceStore::new(4);

        let allowed = mint(&store, true);
        assert!(allowed.may_send_follow_up);
        assert!(
            store
                .get(&allowed.instance_id)
                .expect("just minted")
                .may_send_follow_up,
            "a widget granted `ui:send_message` must still be permitted when the \
             governed route re-reads its instance"
        );

        let refused = mint(&store, false);
        assert!(!refused.may_send_follow_up);
        assert!(
            !store
                .get(&refused.instance_id)
                .expect("just minted")
                .may_send_follow_up,
            "a widget that was never granted `ui:send_message` must not become \
             permitted by passing through the store"
        );
    }

    #[test]
    fn follow_up_ticket_is_bound_to_prompt_and_conversation_and_is_one_shot() {
        let store = WidgetInstanceStore::new(4);
        let record = mint(&store, true);
        let ticket = store
            .issue_follow_up_ticket(&record, "Use the selected row")
            .expect("ticket is minted");

        assert_eq!(
            store.consume_follow_up_ticket(&ticket, "other-conversation", "Use the selected row"),
            Err("widget follow-up ticket does not match this chat turn")
        );
        assert_eq!(
            store.consume_follow_up_ticket(&ticket, "conv1", "Use another prompt"),
            Err("widget follow-up ticket does not match this chat turn")
        );

        let provenance = store
            .consume_follow_up_ticket(&ticket, "conv1", "Use the selected row")
            .expect("matching ticket is accepted");
        assert_eq!(provenance.source, "widget");
        assert_eq!(provenance.widget_instance_id, record.instance_id);
        assert_eq!(provenance.origin_server, "srv");

        assert_eq!(
            store.consume_follow_up_ticket(&ticket, "conv1", "Use the selected row"),
            Err("unknown, expired, or already-used widget follow-up ticket")
        );
    }

    #[test]
    fn follow_up_ticket_peek_survives_rejected_pre_stream_request() {
        let store = WidgetInstanceStore::new(4);
        let record = mint(&store, true);
        let ticket = store
            .issue_follow_up_ticket(&record, "Use the selected row")
            .expect("ticket is minted");

        assert_eq!(
            store.validate_follow_up_ticket(&ticket, "conv1", "Use the selected row"),
            Ok(VerifiedWidgetProvenance {
                source: "widget",
                widget_instance_id: record.instance_id.clone(),
                origin_server: "srv".to_owned(),
                conversation_id: "conv1".to_owned(),
            })
        );
        assert!(store
            .validate_follow_up_ticket(&ticket, "other-conversation", "Use the selected row")
            .is_err());

        store
            .consume_follow_up_ticket(&ticket, "conv1", "Use the selected row")
            .expect("a ticket remains usable after pre-stream rejection");
    }

    #[test]
    fn widget_error_codes_are_closed_and_wire_stable() {
        assert_eq!(
            serde_json::to_value(WidgetErrorCode::OverBudget).unwrap(),
            serde_json::json!("over_budget")
        );
        assert!(matches!(
            WidgetErrorCode::from_wire("unexpected"),
            WidgetErrorCode::ServerError
        ));
    }
}
