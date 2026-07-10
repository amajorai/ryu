//! `POST /v1/exec/tool` — the gateway governance front for direct tool / code
//! execution (#475, Contract 2).
//!
//! The gateway is the governance front (allowlist + audit + gating); execution
//! lands in Core. Three discriminated kinds:
//!   - `tool` (default) → forward to Core `POST /api/mcp/tools/call`, mapping
//!     `{ok,output}` → `{ok,result}`.
//!   - `execute` / `resume` → forward to Core's PTC endpoints (`/api/tools/exec`
//!     and `/api/tools/exec/resume`). Those Core endpoints are **built and live**
//!     (real Deno-subprocess sandbox + parked-execution resume); the gateway is
//!     purely the governance front and returns Core's outcome verbatim.
//!
//! Gating (Contract 2 / B-9): `(trusted_forwarder || master_key) &&
//! !mesh_enabled()`. `agent_id` is logically required (Core is fail-closed and
//! agent-scoped) though the struct marks it `Option` for transport tolerance.

use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

use super::mesh_enabled;

/// Request body for `POST /v1/exec/tool` (Contract 2, verbatim).
#[derive(Debug, Deserialize)]
pub struct ExecToolBody {
    /// "tool" (default) = run a tool id; "execute"/"resume" = forward to Core PTC.
    #[serde(default = "default_exec_kind")]
    pub kind: String,
    pub tool_id: Option<String>,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub execution_id: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub content: Option<Value>,
    #[serde(default)]
    pub request_id: Option<String>,
    pub agent_id: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Product-surface tag (`x-ryu-feature`); `"widget"` for widget round-trips.
    /// Accepted for transport tolerance; the widget branch keys off the presence
    /// of the `widget` envelope and hardcodes `feature="widget"` on the audit row.
    #[serde(default)]
    #[allow(dead_code)]
    pub feature: Option<String>,
    /// Widget envelope (§4.3). Present ⇒ `exec_tool` runs the governed widget
    /// chain (scan → budget → forward → audit) instead of the bare forward the
    /// non-widget `kind=tool` path uses (D5: `exec_tool` owns the chain).
    #[serde(default)]
    pub widget: Option<WidgetEnvelope>,
}

/// The `widget: { instance_id, origin_server }` envelope Core attaches to a
/// widget-initiated `callTool` (§4.3). `instance_id` is the opaque per-render id
/// (the rate-limit + audit key); `origin_server` is the app that owns the
/// widget's output template (recorded as the audit `backend`).
#[derive(Debug, Clone, Deserialize)]
pub struct WidgetEnvelope {
    pub instance_id: String,
    pub origin_server: String,
}

fn default_exec_kind() -> String {
    "tool".to_owned()
}

/// Response for `POST /v1/exec/tool` (Contract 2, verbatim).
#[derive(Debug, Serialize)]
pub struct ExecToolResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ExecToolResponse {
    fn ok(result: Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
        }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(msg.into()),
        }
    }
}

/// `POST /v1/exec/tool` handler.
pub async fn exec_tool(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<ExecToolBody>,
) -> Result<Json<ExecToolResponse>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;

    // Gate: trusted-forwarder or master key, neutralized when mesh is on (B-9).
    let is_trusted =
        ctx.is_master_key || ctx.key_config.as_ref().is_some_and(|k| k.trusted_forwarder);
    if !is_trusted || mesh_enabled() {
        return Err(GatewayError::Unauthorized(
            "Tool execution requires a trusted-forwarder or master key.".to_string(),
        ));
    }

    let Some(catalog) = state.tools.as_ref() else {
        return Ok(Json(ExecToolResponse::err(
            "tool execution unavailable: Core URL not configured (CORE_URL)",
        )));
    };

    // Widget round-trips (§4.3 / D5): when the request carries the widget
    // envelope, the gateway owns the FULL governance chain — scan → budget →
    // forward → audit — keyed to the widget instance. This is the concrete gap
    // the envelope closes over the bare `kind=tool` forward below; Core does not
    // separately scan/budget/audit (D5).
    if body.widget.is_some() {
        return exec_widget_tool(&state, catalog, &ctx.api_key, body).await;
    }

    match body.kind.as_str() {
        "tool" => exec_kind_tool(catalog, body).await,
        "execute" => exec_kind_forward(catalog, "/api/tools/exec", &body).await,
        "resume" => exec_kind_forward(catalog, "/api/tools/exec/resume", &body).await,
        other => Ok(Json(ExecToolResponse::err(format!(
            "unknown exec kind '{other}' (expected tool|execute|resume)"
        )))),
    }
}

/// The governed widget `callTool` chain (§4.3 / D5): scan → budget → forward →
/// audit, keyed to the widget instance. Every outcome (allow or any denial) is
/// audited as a `feature="widget"` `ExecCall` carrying the `widget_instance_id`.
///
/// - **scan**: when `widget.scan_arguments` is on, the serialized arguments are
///   run through the inbound firewall (PII / secret / prompt-injection). A hit
///   denies the call, fail-closed.
/// - **budget**: the sandbox exec budget (this call is an `ExecCall` that drains
///   it) plus the per-instance per-minute widget call token bucket (§4.3).
/// - **forward**: to Core `POST /api/mcp/tools/call` via the catalog client.
/// - **audit**: one widget-call row, then `exec_budget.record(duration)`.
async fn exec_widget_tool(
    state: &SharedState,
    catalog: &dyn super::CoreCatalog,
    api_key: &str,
    body: ExecToolBody,
) -> Result<Json<ExecToolResponse>, GatewayError> {
    let widget = body
        .widget
        .as_ref()
        .expect("exec_widget_tool called with a widget envelope");
    let cfg = &state.config.widget;
    let instance_id = widget.instance_id.clone();
    let origin_server = widget.origin_server.clone();

    // A widget callTool must name a tool id (it is always a `kind=tool` call).
    let Some(tool_id) = body
        .tool_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
    else {
        return Ok(Json(ExecToolResponse::err(
            "tool_id is required for a widget callTool",
        )));
    };

    // Audit one widget-call row (allow ⇒ error=None; any denial ⇒ error=reason).
    let audit_call = |duration_ms: u64, error: Option<String>| {
        if state.audit.is_enabled() {
            state
                .audit
                .log(crate::audit::AuditLogger::make_widget_call_record(
                    uuid::Uuid::new_v4().to_string(),
                    api_key.to_owned(),
                    origin_server.clone(),
                    tool_id.clone(),
                    body.agent_id.clone(),
                    body.session_id.clone(),
                    instance_id.clone(),
                    duration_ms,
                    error,
                ));
        }
    };

    // ── scan ─────────────────────────────────────────────────────────────────
    if cfg.enabled && cfg.scan_arguments {
        let args_text = body.arguments.to_string();
        if let Some(m) = state.with_firewall(|fw| fw.scan_inbound(&args_text)) {
            let reason = format!("firewall {:?}: {}", m.kind, m.pattern_name);
            audit_call(0, Some(reason.clone()));
            return Ok(Json(ExecToolResponse::err(format!(
                "widget call denied ({reason})"
            ))));
        }
    }

    // ── budget ─────────────────────────────────────────────────────────────────
    // Sandbox exec budget (this call drains it like any tool run).
    if let crate::budget::ExecBudgetResult::Deny { .. } = state.exec_budget.check() {
        let reason = "exec budget exhausted".to_owned();
        audit_call(0, Some(reason.clone()));
        return Ok(Json(ExecToolResponse::err(format!(
            "widget call denied ({reason})"
        ))));
    }
    // Per-instance per-minute widget call rate limit (§4.3).
    if !crate::api::audit::widget_call_allowed(cfg, &instance_id) {
        let reason = format!(
            "widget call rate limit exhausted ({} calls/min)",
            cfg.max_calls_per_min
        );
        audit_call(0, Some(reason.clone()));
        return Ok(Json(ExecToolResponse::err(format!(
            "widget call denied ({reason})"
        ))));
    }

    // ── forward ─────────────────────────────────────────────────────────────────
    let start = std::time::Instant::now();
    let outcome = catalog
        .call_tool(
            &tool_id,
            body.arguments.clone(),
            body.agent_id.as_deref(),
            body.user_id.as_deref(),
        )
        .await;
    let duration_ms = start.elapsed().as_millis() as u64;
    // Record the exec against the sandbox exec-budget window (allow or error —
    // it reached Core and consumed compute either way).
    state.exec_budget.record(duration_ms);

    // ── audit ─────────────────────────────────────────────────────────────────
    match outcome {
        Ok(result) => {
            audit_call(duration_ms, None);
            Ok(Json(ExecToolResponse::ok(result)))
        }
        Err(e) => {
            audit_call(duration_ms, Some(e.clone()));
            Ok(Json(ExecToolResponse::err(e)))
        }
    }
}

/// `kind=tool` → Core `POST /api/mcp/tools/call`.
async fn exec_kind_tool(
    catalog: &dyn super::CoreCatalog,
    body: ExecToolBody,
) -> Result<Json<ExecToolResponse>, GatewayError> {
    let Some(tool_id) = body.tool_id.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(Json(ExecToolResponse::err(
            "tool_id is required when kind=tool",
        )));
    };
    match catalog
        .call_tool(
            tool_id,
            body.arguments,
            body.agent_id.as_deref(),
            body.user_id.as_deref(),
        )
        .await
    {
        Ok(result) => Ok(Json(ExecToolResponse::ok(result))),
        Err(e) => Ok(Json(ExecToolResponse::err(e))),
    }
}

/// `kind=execute|resume` → Core PTC endpoints (`/api/tools/exec[/resume]`, live).
/// The gateway is the governance front; Core runs the sandbox and returns the
/// flat `ExecOutcome` envelope, which is relayed back verbatim as `result`. Any
/// Core-side error (e.g. a `404 execution_not_found` on resume, a missing/unknown
/// agent, or no backend built) is surfaced as-is.
async fn exec_kind_forward(
    catalog: &dyn super::CoreCatalog,
    path: &str,
    body: &ExecToolBody,
) -> Result<Json<ExecToolResponse>, GatewayError> {
    let forward = json!({
        "agent_id": body.agent_id,
        "user_id": body.user_id,
        "session_id": body.session_id,
        "conversation_id": body.session_id,
        "code": body.code,
        "execution_id": body.execution_id,
        "action": body.action,
        "content": body.content,
        "request_id": body.request_id,
    });
    match catalog.forward_exec(path, forward).await {
        Ok(result) => Ok(Json(ExecToolResponse::ok(result))),
        Err(e) => Ok(Json(ExecToolResponse::err(format!(
            "code execution failed: {e}"
        )))),
    }
}

use crate::firewall::cmdscan::{scan_command, ApprovalMode, ScanVerdict};

/// Request body for `POST /v1/exec/scan` (COMMAND-SCAN CONTRACT, verbatim shape).
#[derive(Debug, Deserialize)]
pub struct ExecScanBody {
    pub backend: String,
    pub command: String,
    // Accepted for transport tolerance / audit correlation on the Core side; not
    // consulted by the pure scanner (verdict is a function of backend+command).
    #[serde(default)]
    #[allow(dead_code)]
    pub session_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub agent: Option<String>,
}

/// `POST /v1/exec/scan` — pre-exec command governance. Returns the verbatim
/// `{ decision, reason, findings }` shape. Trusted-forwarder / master-key only
/// (same governance gate as the exec-budget endpoints; NO mesh check, matching
/// its sibling `check_exec_budget`). Mode is read from `RYU_EXEC_APPROVAL_MODE`
/// at this boundary; the scanner itself is pure. The HARDLINE blocklist always
/// denies regardless of mode.
pub async fn exec_scan(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<ExecScanBody>,
) -> Result<Json<ScanVerdict>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    let is_trusted =
        ctx.is_master_key || ctx.key_config.as_ref().is_some_and(|k| k.trusted_forwarder);
    if !is_trusted {
        return Err(GatewayError::Unauthorized(
            "Exec scan requires a trusted-forwarder or master key.".to_string(),
        ));
    }
    let mode = std::env::var("RYU_EXEC_APPROVAL_MODE")
        .map(|s| ApprovalMode::from_env_str(&s))
        .unwrap_or(ApprovalMode::Manual);
    let verdict = scan_command(&body.backend, &body.command, mode);
    Ok(Json(verdict))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_kind_defaults_to_tool() {
        let body: ExecToolBody = serde_json::from_value(json!({ "tool_id": "x" })).unwrap();
        assert_eq!(body.kind, "tool");
    }

    #[test]
    fn exec_response_omits_none_fields() {
        let ok = ExecToolResponse::ok(json!({"a":1}));
        let v = serde_json::to_value(&ok).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["result"]["a"], 1);
        assert!(v.get("error").is_none());

        let err = ExecToolResponse::err("boom");
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"], "boom");
        assert!(v.get("result").is_none());
    }

    #[test]
    fn map_core_ok_maps_both_branches() {
        use crate::tools::catalog_client::map_core_ok;
        // {ok:true,output} → Ok(output)
        let ok = map_core_ok(json!({ "ok": true, "output": { "a": 1 } })).unwrap();
        assert_eq!(ok, json!({ "a": 1 }));
        // {ok:false,error} → Err(error)  (acceptance #3 mapping)
        let err = map_core_ok(json!({ "ok": false, "error": "boom" })).unwrap_err();
        assert_eq!(err, "boom");
        // Missing ok flag is treated as failure.
        assert!(map_core_ok(json!({})).is_err());
    }

    /// Acceptance #3: exec_tool rejects a non-trusted, non-master caller.
    #[tokio::test]
    async fn exec_tool_rejects_non_trusted_key() {
        use crate::state::AppState;
        use axum::extract::State;
        use std::sync::Arc;

        // Default config: no master key, require_auth=false, no Core wiring.
        // authenticate() yields is_master_key=false + key_config=None, so the
        // caller is neither master nor a trusted forwarder → must be rejected.
        let state = Arc::new(AppState::new(crate::config::GatewayConfig::default()));
        let headers = HeaderMap::new();
        let body: ExecToolBody =
            serde_json::from_value(json!({ "kind": "tool", "tool_id": "x", "agent_id": "a" }))
                .unwrap();

        let result = exec_tool(State(state), headers, Json(body)).await;
        assert!(
            matches!(result, Err(GatewayError::Unauthorized(_))),
            "non-trusted caller must be rejected"
        );
    }

    /// `/v1/exec/scan` rejects a non-trusted, non-master caller (same gate as the
    /// exec-budget governance endpoints).
    #[tokio::test]
    async fn exec_scan_rejects_non_trusted_key() {
        use crate::state::AppState;
        use axum::extract::State;
        use std::sync::Arc;

        let state = Arc::new(AppState::new(crate::config::GatewayConfig::default()));
        let headers = HeaderMap::new();
        let body: ExecScanBody =
            serde_json::from_value(json!({ "backend": "bash", "command": "ls" })).unwrap();

        let result = exec_scan(State(state), headers, Json(body)).await;
        assert!(
            matches!(result, Err(GatewayError::Unauthorized(_))),
            "non-trusted caller must be rejected from exec scan"
        );
    }
}
