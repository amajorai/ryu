use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::widget_limiter::{widget_call_allowed, widget_followup_allowed};
use crate::{
    audit::AuditLogger,
    budget::ExecBudgetResult,
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
    tools::exec::WidgetEnvelope,
};

/// Bound metadata Core forwards for a tool/exec audit row. These values are
/// labels and correlation keys only; the trusted-forwarder gate above remains
/// the authorization boundary.
fn bounded_audit_identity(
    value: Option<String>,
    field: &str,
) -> Result<Option<String>, GatewayError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > 240 {
        return Err(GatewayError::BadRequest(format!(
            "audit {field} is too long"
        )));
    }
    Ok(Some(value))
}

// ── Exec audit ingest (M6 / #192) ────────────────────────────────────────────

/// Body accepted by `POST /v1/exec/audit`.
///
/// Sent by Core's sandbox backends after each execution. The `api_key` header
/// must belong to a `trusted_forwarder` key (or the master key) so only Core
/// — not arbitrary callers — can ingest exec events.
#[derive(Debug, Deserialize)]
pub struct ExecAuditBody {
    /// Sandbox backend that ran the command (e.g. `"wasmtime"`, `"docker"`).
    pub backend: String,
    /// Command or tool name that was executed.
    pub command: String,
    /// Wall-clock duration of the execution in milliseconds.
    pub duration_ms: u64,
    /// Exit code returned by the sandbox process.
    pub exit_code: i32,
    /// Optional Core session/conversation id for correlation.
    pub session_id: Option<String>,
    /// Optional error message if the execution failed.
    pub error: Option<String>,
    /// Event discriminator (#523). Omitted/`"exec_call"` records a sandbox exec
    /// (the original behavior, which drains the exec budget); `"credential_read"`
    /// records an identity-vault credential read as a distinct event that does
    /// NOT drain the exec budget. Unknown values fall back to `exec_call`.
    #[serde(default)]
    pub event_type: Option<String>,
    /// Verified Core attribution. The endpoint only accepts trusted-forwarder or
    /// master credentials, so these fields are metadata, never authorization.
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub user_name: Option<String>,
    #[serde(default)]
    pub feature: Option<String>,
}

/// Body accepted by `POST /v1/exec/budget/check`.
///
/// Core calls this BEFORE running an execution to get a go/no-go decision.
/// Fail-closed: if the gateway is unreachable, Core must refuse to exec
/// (unless `RYU_ALLOW_GATEWAY_FALLBACK=1`).
#[derive(Debug, Deserialize)]
pub struct ExecBudgetCheckBody {
    /// Sandbox backend that will run the command (informational; not enforced here).
    #[allow(dead_code)]
    pub backend: String,
    /// Command or tool that will be executed (informational).
    #[allow(dead_code)]
    pub command: String,
    /// Product-surface tag (`x-ryu-feature`); `"widget"` for widget round-trips.
    /// Accepted for transport tolerance / audit correlation; the widget branch
    /// keys off the `widget` envelope, not this tag.
    #[serde(default)]
    #[allow(dead_code)]
    pub feature: Option<String>,
    /// Widget envelope (§4.3). When present, the per-instance widget call token
    /// bucket is consulted in addition to the sandbox exec budget, so a pre-run
    /// gate for a widget `callTool` is rate-limited per rendered instance.
    #[serde(default)]
    pub widget: Option<WidgetEnvelope>,
}

/// Response from `POST /v1/exec/budget/check`.
#[derive(Debug, Serialize)]
pub struct ExecBudgetCheckResponse {
    /// Whether the execution is permitted.
    pub allowed: bool,
    /// Human-readable reason (populated on deny).
    pub reason: Option<String>,
    /// Current exec count in the rolling window.
    pub current_count: u64,
    /// Configured max count per window (0 = unlimited).
    pub max_count: u64,
}

/// `POST /v1/exec/audit` — ingest a non-model exec event from Core's sandbox.
///
/// Authentication: trusted-forwarder or master-key only.  Open ingest would
/// allow anyone to forge rows and drain exec budgets without running anything.
pub async fn ingest_exec_audit(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<ExecAuditBody>,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;

    // Only trusted-forwarder keys (Core's internal key) or the master key may
    // ingest exec events. This prevents anyone who can make HTTP requests from
    // forging exec rows and inflating or exhausting exec budgets.
    let is_trusted =
        ctx.is_master_key || ctx.key_config.as_ref().is_some_and(|k| k.trusted_forwarder);
    if !is_trusted {
        return Err(GatewayError::Unauthorized(
            "Exec audit ingest requires a trusted-forwarder or master key.".to_string(),
        ));
    }
    // A managed node's org-bound relay key writes rows for its own org only.
    let forwarder_org =
        crate::pipeline::org_core_relay::bound_forwarder_org(&ctx).map(str::to_owned);

    if body.event_type.as_deref() == Some("service_call") {
        return Err(GatewayError::BadRequest(
            "service audit events must be recorded by the Gateway service pipeline".to_owned(),
        ));
    }

    // Identity-vault credential reads (#523) are recorded as a distinct event
    // and must NOT drain the sandbox exec budget. Any other value (incl. the
    // default) is treated as a sandbox exec, preserving the original behavior.
    let is_credential_read = body
        .event_type
        .as_deref()
        .is_some_and(|t| t == "credential_read");
    let agent_id = bounded_audit_identity(body.agent_id, "agent_id")?;
    let user_id = bounded_audit_identity(body.user_id, "user_id")?;
    let user_name = bounded_audit_identity(body.user_name, "user_name")?;
    let feature = bounded_audit_identity(body.feature, "feature")?;

    if is_credential_read {
        if state.audit.is_enabled() {
            // `backend` carries the CredentialSource id, `command` the domain —
            // never the secret itself (Core sends only the domain).
            let mut record = AuditLogger::make_credential_read_record(
                Uuid::new_v4().to_string(),
                ctx.api_key.clone(),
                body.backend,
                body.command,
                body.session_id,
                body.error,
            );
            record.agent_id = agent_id;
            record.user_id = user_id;
            record.user_name = user_name;
            record.feature = feature;
            record.org_id = forwarder_org;
            state.log_audit(record);
        }
        return Ok(Json(json!({ "ok": true })));
    }

    // Record the execution against the rolling exec-budget counter: an
    // org-bound relay's own window, so it never drains another org's.
    state
        .exec_budget
        .record_scoped(forwarder_org.as_deref(), body.duration_ms);

    if state.audit.is_enabled() {
        let mut record = AuditLogger::make_exec_record(
            Uuid::new_v4().to_string(),
            ctx.api_key.clone(),
            body.backend,
            body.command,
            body.duration_ms,
            body.exit_code,
            body.session_id,
            body.error,
        );
        record.agent_id = agent_id;
        record.user_id = user_id;
        record.user_name = user_name;
        record.feature = feature;
        record.org_id = forwarder_org.clone();
        state.log_audit(record);
    }

    Ok(Json(json!({
        "ok": true,
        "exec_count": state.exec_budget.current_count_scoped(forwarder_org.as_deref()),
    })))
}

/// `POST /v1/exec/budget/check` — pre-run budget gate.
///
/// Core calls this BEFORE running a sandbox execution. Returns `allowed: false`
/// when the exec budget is exhausted and the configured action is `stop`.
///
/// Authentication: trusted-forwarder or master-key only (same as ingest).
pub async fn check_exec_budget(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<ExecBudgetCheckBody>,
) -> Result<Json<ExecBudgetCheckResponse>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;

    let is_trusted =
        ctx.is_master_key || ctx.key_config.as_ref().is_some_and(|k| k.trusted_forwarder);
    if !is_trusted {
        return Err(GatewayError::Unauthorized(
            "Exec budget check requires a trusted-forwarder or master key.".to_string(),
        ));
    }

    // An org-bound relay is checked against its own org's window only.
    let org = crate::pipeline::org_core_relay::bound_forwarder_org(&ctx);
    let result = state.exec_budget.check_scoped(org);
    let current_count = state.exec_budget.current_count_scoped(org);
    let max_count = state.config.exec_budget.max_count;

    match result {
        ExecBudgetResult::Allow => {
            // Widget calls also drain a per-instance per-minute token bucket
            // (§4.3), consulted only when the request carries the widget
            // envelope. Keyed by instance_id so widgets stay isolated.
            if let Some(widget) = body.widget.as_ref() {
                let allowed = if body.feature.as_deref() == Some("widget-followup") {
                    widget_followup_allowed(&state.config.widget, &widget.instance_id)
                } else {
                    widget_call_allowed(&state.config.widget, &widget.instance_id)
                };
                if !allowed {
                    let kind = if body.feature.as_deref() == Some("widget-followup") {
                        "follow-up"
                    } else {
                        "call"
                    };
                    return Ok(Json(ExecBudgetCheckResponse {
                        allowed: false,
                        reason: Some(format!(
                            "Widget {kind} rate limit exhausted for instance {}.",
                            widget.instance_id
                        )),
                        current_count,
                        max_count,
                    }));
                }
            }
            Ok(Json(ExecBudgetCheckResponse {
                allowed: true,
                reason: None,
                current_count,
                max_count,
            }))
        }
        ExecBudgetResult::Deny {
            exec_count,
            wall_clock_secs,
            limit_count,
            limit_wall_clock_secs,
        } => {
            let reason = if limit_count > 0 && exec_count >= limit_count {
                format!(
                    "Exec budget exhausted: {exec_count}/{limit_count} executions in this window."
                )
            } else {
                format!(
                    "Exec budget exhausted: {wall_clock_secs}s/{limit_wall_clock_secs}s wall-clock in this window."
                )
            };
            Ok(Json(ExecBudgetCheckResponse {
                allowed: false,
                reason: Some(reason),
                current_count,
                max_count,
            }))
        }
    }
}
