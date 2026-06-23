use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{AuditLogger, AuditQuery},
    budget::ExecBudgetResult,
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

/// Query-string parameters accepted by `GET /v1/audit`.
#[derive(Debug, Deserialize)]
pub struct AuditQueryParams {
    pub api_key: Option<String>,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub errors_only: bool,
    pub limit: Option<u32>,
    /// Filter by gateway-internal request id (M4 / #176).
    pub request_id: Option<String>,
    /// Filter by Core session/conversation id (M4 / #176).
    pub session_id: Option<String>,
}

/// Local audit-log query endpoint. Restricted to the master key: audit data is
/// sensitive and tenant-wide, so per-tenant API keys cannot read it.
pub async fn query_audit(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<AuditQueryParams>,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    // The audit query endpoint is master-key only and not budget-scoped, so no
    // per-user / per-agent identity is threaded here.
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key))?;

    // Audit data is tenant-wide, so the master key is always sufficient. Without
    // it, access is allowed ONLY from a loopback peer in no-auth mode — never
    // from a remote host. The gateway can bind 0.0.0.0 (config default), so
    // `require_auth` alone (a *base*-auth flag) must not gate this admin surface.
    if !ctx.is_master_key {
        let require_auth = state.with_auth(|a| a.require_auth);
        // Loopback trust neutralized under mesh (#478, B-9): userspace-networking
        // tailnet peers appear as 127.0.0.1, so a bare loopback check fails OPEN.
        let loopback_trusted = peer.ip().is_loopback() && !crate::tools::mesh_enabled();
        if require_auth || !loopback_trusted {
            return Err(GatewayError::Unauthorized(
                "Audit log access requires the master key.".to_string(),
            ));
        }
    }

    if !state.audit.is_enabled() {
        return Err(GatewayError::Internal(anyhow::anyhow!(
            "Audit logging is disabled on this gateway."
        )));
    }

    let query = AuditQuery {
        api_key: params.api_key,
        org_id: params.org_id,
        team_id: params.team_id,
        project_id: params.project_id,
        provider: params.provider,
        model: params.model,
        errors_only: params.errors_only,
        limit: params.limit,
        request_id: params.request_id,
        session_id: params.session_id,
    };

    let entries = state
        .audit
        .query(&query)
        .map_err(|e| GatewayError::Internal(anyhow::anyhow!("audit query failed: {e}")))?;

    // Enrich each model-call row with a DERIVED estimated cost (#548, P6) so the
    // desktop trace viewer can show per-run cost without re-deriving the rate. The
    // GenAI OTel conventions define no cost attribute (cost is derived from tokens),
    // so this is the one place the gateway exposes its estimate. The rate is the
    // single source already used for wallet debit + the control-plane report
    // (`control_plane.cost_per_1k_micro_usd`), so they never diverge. A rate of 0
    // (cost attribution disabled) maps to `null` — not a misleading "$0.00".
    let per_1k = state.config.control_plane.cost_per_1k_micro_usd;
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|e| {
            let cost_micro_usd: Option<u64> = if per_1k == 0 {
                None
            } else {
                Some(estimate_cost_micro_usd(e.input_tokens, e.output_tokens, per_1k))
            };
            let mut v = serde_json::to_value(&e).unwrap_or_else(|_| json!({}));
            if let Value::Object(map) = &mut v {
                map.insert("cost_micro_usd".to_string(), json!(cost_micro_usd));
            }
            v
        })
        .collect();

    Ok(Json(json!({
        "count": entries.len(),
        "entries": entries,
    })))
}

/// Estimated spend in micro-USD for the given token totals at the configured
/// per-1k-token rate. Mirrors `pipeline::request_cost_micro_usd` so the audit's
/// surfaced cost matches the wallet debit + control-plane report exactly. Pure so
/// the rounding (`/ 1000`) is unit-testable.
fn estimate_cost_micro_usd(input_tokens: u64, output_tokens: u64, per_1k_micro_usd: u64) -> u64 {
    input_tokens
        .saturating_add(output_tokens)
        .saturating_mul(per_1k_micro_usd)
        / 1000
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
}

/// Body accepted by `POST /v1/exec/budget/check`.
///
/// Core calls this BEFORE running an execution to get a go/no-go decision.
/// Fail-closed: if the gateway is unreachable, Core must refuse to exec
/// (unless `RYU_ALLOW_GATEWAY_FALLBACK=1`).
#[derive(Debug, Deserialize)]
pub struct ExecBudgetCheckBody {
    /// Sandbox backend that will run the command (informational; not enforced here).
    pub backend: String,
    /// Command or tool that will be executed (informational).
    pub command: String,
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
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key))?;

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

    // Identity-vault credential reads (#523) are recorded as a distinct event
    // and must NOT drain the sandbox exec budget. Any other value (incl. the
    // default) is treated as a sandbox exec, preserving the original behavior.
    let is_credential_read = body
        .event_type
        .as_deref()
        .is_some_and(|t| t == "credential_read");

    if is_credential_read {
        if state.audit.is_enabled() {
            // `backend` carries the CredentialSource id, `command` the domain —
            // never the secret itself (Core sends only the domain).
            let record = AuditLogger::make_credential_read_record(
                Uuid::new_v4().to_string(),
                ctx.api_key.clone(),
                body.backend,
                body.command,
                body.session_id,
                body.error,
            );
            state.audit.log(record);
        }
        return Ok(Json(json!({ "ok": true })));
    }

    // Record the execution against the rolling exec-budget counter.
    state.exec_budget.record(body.duration_ms);

    if state.audit.is_enabled() {
        let record = AuditLogger::make_exec_record(
            Uuid::new_v4().to_string(),
            ctx.api_key.clone(),
            body.backend,
            body.command,
            body.duration_ms,
            body.exit_code,
            body.session_id,
            body.error,
        );
        state.audit.log(record);
    }

    Ok(Json(json!({
        "ok": true,
        "exec_count": state.exec_budget.current_count(),
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
    Json(_body): Json<ExecBudgetCheckBody>,
) -> Result<Json<ExecBudgetCheckResponse>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key))?;

    let is_trusted =
        ctx.is_master_key || ctx.key_config.as_ref().is_some_and(|k| k.trusted_forwarder);
    if !is_trusted {
        return Err(GatewayError::Unauthorized(
            "Exec budget check requires a trusted-forwarder or master key.".to_string(),
        ));
    }

    let result = state.exec_budget.check();
    let current_count = state.exec_budget.current_count();
    let max_count = state.config.exec_budget.max_count;

    match result {
        ExecBudgetResult::Allow => Ok(Json(ExecBudgetCheckResponse {
            allowed: true,
            reason: None,
            current_count,
            max_count,
        })),
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

#[cfg(test)]
mod tests {
    use super::estimate_cost_micro_usd;

    #[test]
    fn cost_estimate_matches_pipeline_rounding() {
        // 1000 in + 0 out at $0.002/1k = 2000 micro-USD.
        assert_eq!(estimate_cost_micro_usd(1000, 0, 2000), 2000);
        // Split across input/output is the same as the combined total.
        assert_eq!(estimate_cost_micro_usd(500, 500, 2000), 2000);
        // Multiply-then-divide matches the wallet debit: 1 token * 2000 / 1000 = 2.
        assert_eq!(estimate_cost_micro_usd(1, 0, 2000), 2);
        assert_eq!(estimate_cost_micro_usd(1500, 0, 2000), 3000);
        // Tiny token counts can round to 0 when the rate is sub-1k per token.
        assert_eq!(estimate_cost_micro_usd(1, 0, 1), 0);
        // A zero rate (cost attribution disabled) yields zero here; the endpoint
        // maps a zero RATE to `null`, not this function.
        assert_eq!(estimate_cost_micro_usd(1000, 1000, 0), 0);
    }
}
