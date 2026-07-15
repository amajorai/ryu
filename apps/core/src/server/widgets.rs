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
        return err_reply(StatusCode::NOT_FOUND, "not_found", "unknown or expired widget instance");
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
//   3. an SSRF guard rejects private/loopback/link-local/metadata targets even
//      if an allowlist entry names one (DNS-rebinding is a documented residual).
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
        return err_reply(StatusCode::BAD_REQUEST, "invalid_args", "asset url is not a valid URL");
    };
    if target.scheme() != "https" {
        return err_reply(StatusCode::BAD_REQUEST, "invalid_args", "asset url must be https");
    }
    let Some(host) = target.host_str().map(str::to_ascii_lowercase) else {
        return err_reply(StatusCode::BAD_REQUEST, "invalid_args", "asset url has no host");
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

    // 4. SSRF guard: never proxy an internal target, even if allowlisted.
    if host_is_blocked(&host) {
        return err_reply(
            StatusCode::FORBIDDEN,
            "denied",
            "asset host resolves to a blocked address range",
        );
    }

    // 5. Resolve the host off-runtime and reject if ANY resolved address is
    //    internal (this closes the DNS-rebinding residual left by the literal
    //    `host_is_blocked` check in step 4). We then pin the client to exactly
    //    those addresses so no re-resolution can occur between here and connect.
    let started = Instant::now();
    let port = target.port_or_known_default().unwrap_or(443);
    let resolve_host = host.clone();
    let resolved: Vec<std::net::SocketAddr> = match tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<_>>())
    })
    .await
    {
        Ok(Ok(addrs)) => addrs,
        _ => {
            audit_asset(&record, &host, 0, started, Some("dns resolution failed".to_owned())).await;
            return err_reply(StatusCode::BAD_GATEWAY, "server_error", "asset host did not resolve");
        }
    };
    if resolved.is_empty() || resolved.iter().any(|a| ip_is_blocked(&a.ip())) {
        audit_asset(&record, &host, 0, started, Some("resolves to blocked range".to_owned())).await;
        return err_reply(
            StatusCode::FORBIDDEN,
            "denied",
            "asset host resolves to a blocked address range",
        );
    }

    // 6. Fetch server-side (the ONLY egress lane; Core/Gateway mediate it) with a
    //    client pinned to the validated IPs AND redirects DISABLED. A remote can no
    //    longer 3xx-bounce us to an internal host (169.254.169.254, 127.0.0.1,
    //    a private-LAN IP) after the guards ran — a redirect returns as a 3xx
    //    status and is rejected by the `is_success()` gate below. Mirrors the
    //    manifest client at `server/mod.rs` (`redirect::Policy::none()`).
    let client = match reqwest::Client::builder()
        .timeout(WIDGET_ASSET_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &resolved)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            audit_asset(&record, &host, 0, started, Some(format!("client build failed: {e}"))).await;
            return err_reply(
                StatusCode::BAD_GATEWAY,
                "server_error",
                format!("asset client build failed: {e}"),
            );
        }
    };
    let resp = match client
        .get(target.as_str())
        .header(header::ACCEPT, "image/*,font/*,audio/*,video/*,*/*;q=0.1")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            audit_asset(&record, &host, 0, started, Some(format!("fetch failed: {e}"))).await;
            return err_reply(
                StatusCode::BAD_GATEWAY,
                "server_error",
                format!("asset fetch failed: {e}"),
            );
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        audit_asset(&record, &host, 0, started, Some(format!("upstream {status}"))).await;
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
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
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

    // 8. Size-capped streaming read.
    let bytes = match read_capped(resp, WIDGET_ASSET_MAX_BYTES).await {
        Ok(b) => b,
        Err(msg) => {
            audit_asset(&record, &host, 0, started, Some(msg.clone())).await;
            return err_reply(StatusCode::BAD_GATEWAY, "server_error", msg);
        }
    };
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
        Some(tpl) => state.mcp.widget_resource(server, tpl).await.and_then(|r| r.meta),
        None => None,
    };
    meta.as_ref().map(parse_resource_domains).unwrap_or_default()
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
        e.split('/').next()?.split(':').next()?.trim().to_ascii_lowercase()
    };
    if host.is_empty() || host.contains('*') || !host.contains('.') {
        return None;
    }
    Some(host)
}

/// True when a host must never be proxied (SSRF guard): an internal name, or an
/// IP literal in a private/loopback/link-local/metadata range. DNS names that
/// *resolve* to such addresses (rebinding) are a documented residual — the
/// allowlist is the primary boundary.
fn host_is_blocked(host: &str) -> bool {
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip_is_blocked(&ip);
    }
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".internal")
        || host.ends_with(".local")
}

fn ip_is_blocked(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.octets()[0] == 0
        }
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return true;
            }
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return ip_is_blocked(&std::net::IpAddr::V4(mapped));
            }
            let seg0 = v6.segments()[0];
            // fc00::/7 unique-local, fe80::/10 link-local.
            (seg0 & 0xfe00) == 0xfc00 || (seg0 & 0xffc0) == 0xfe80
        }
    }
}

/// Passive-media content types only. `application/octet-stream` is permitted (CDNs
/// serve fonts/images as it) — safe because the frame's `script-src` is nonce-only,
/// so a mislabeled script can never execute regardless of what this returns.
fn content_type_is_allowed(ct: &str) -> bool {
    let m = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    m.starts_with("image/")
        || m.starts_with("font/")
        || m.starts_with("audio/")
        || m.starts_with("video/")
        || m == "application/font-woff"
        || m == "application/font-woff2"
        || m == "application/vnd.ms-fontobject"
        || m == "application/octet-stream"
}

/// Read a response body, failing closed above `max` bytes.
async fn read_capped(mut resp: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("asset read error: {e}"))?
    {
        if buf.len() + chunk.len() > max {
            return Err("asset exceeds size cap".to_owned());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// Emit a Gateway exec-audit for a proxied asset fetch so every widget egress is
/// visible to the moat (the governance property the `connect-src 'none'` lock +
/// this proxy jointly provide). Best-effort; never blocks the response.
async fn audit_asset(
    record: &WidgetInstance,
    host: &str,
    bytes: usize,
    started: Instant,
    error: Option<String>,
) {
    crate::sidecar::gateway::report_exec_audit(
        "widget-asset",
        &format!("GET https://{host} ({bytes} bytes)"),
        started.elapsed().as_millis() as u64,
        i32::from(error.is_some()),
        Some(record.conversation_id.clone()),
        error,
    )
    .await;
}

// ── Widget resource fetch (reload / third-party fallback) ────────────────────

/// `GET /api/apps/ui/:slug` — serve a built-in app's self-contained widget HTML
/// by slug (the reload / third-party fetch fallback; live widgets embed the HTML
/// in the stream part).
#[utoipa::path(
    get,
    path = "/api/apps/ui/{slug}",
    tag = "Plugins",
    summary = "serve a built-in app's self-contained widget HTML",
    params(("slug" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
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

#[cfg(test)]
mod asset_proxy_tests {
    use super::{
        content_type_is_allowed, host_is_blocked, normalize_allow_host, parse_resource_domains,
    };
    use serde_json::json;

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
    fn ssrf_guard_blocks_private_loopback_linklocal_and_metadata() {
        // Metadata + private + loopback + link-local IPv4.
        assert!(host_is_blocked("169.254.169.254")); // cloud metadata
        assert!(host_is_blocked("127.0.0.1"));
        assert!(host_is_blocked("10.0.0.5"));
        assert!(host_is_blocked("192.168.1.1"));
        assert!(host_is_blocked("172.16.0.1"));
        assert!(host_is_blocked("0.0.0.0"));
        // IPv6 loopback + ULA + link-local + IPv4-mapped private.
        assert!(host_is_blocked("::1"));
        assert!(host_is_blocked("fc00::1"));
        assert!(host_is_blocked("fe80::1"));
        assert!(host_is_blocked("::ffff:10.0.0.1"));
        // Internal names.
        assert!(host_is_blocked("localhost"));
        assert!(host_is_blocked("db.internal"));
        assert!(host_is_blocked("printer.local"));
        // A real public host is NOT blocked.
        assert!(!host_is_blocked("cdn.example.com"));
        assert!(!host_is_blocked("8.8.8.8"));
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
}
