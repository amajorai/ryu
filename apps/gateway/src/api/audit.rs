use std::net::SocketAddr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::{
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
    Json,
};
use chrono::{DateTime, Duration as ChronoDuration};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::{AuditLogger, AuditQuery, AuditUsageQuery},
    budget::ExecBudgetResult,
    config::WidgetConfig,
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
    tools::exec::WidgetEnvelope,
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
    /// Inclusive lower bound for the ISO/UTC timestamp range.
    pub from: Option<String>,
    /// Exclusive upper bound for the ISO/UTC timestamp range.
    pub until: Option<String>,
    /// Filter by gateway-internal request id (M4 / #176).
    pub request_id: Option<String>,
    /// Filter by Core session/conversation id (M4 / #176).
    pub session_id: Option<String>,
    /// Filter by widget instance id (Ryu Apps, §4.4).
    pub widget_instance_id: Option<String>,
    /// Filter by event discriminator, including `control_change`.
    pub event_type: Option<String>,
}

/// Query-string parameters accepted by `GET /v1/audit/usage`.
#[derive(Debug, Deserialize)]
pub struct AuditUsageQueryParams {
    /// Inclusive RFC 3339 lower bound.
    pub from: String,
    /// Exclusive RFC 3339 upper bound.
    pub until: String,
    pub provider: Option<String>,
    pub model: Option<String>,
}

/// Body accepted by `POST /v1/audit/control`. The gateway derives the actor
/// from the authenticated admin context; Core may additionally submit a
/// bounded, already-verified actor identity so the local row can name the user
/// who initiated the control-plane call. Raw config payloads are never accepted.
#[derive(Debug, Deserialize)]
pub struct ControlAuditBody {
    pub action: String,
    pub target: String,
    #[serde(default)]
    pub summary: Option<String>,
    /// Optional verified Core user identity for a local proxy call. Direct
    /// gateway-admin callers omit this and are recorded as gateway admins.
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub actor_name: Option<String>,
}

fn bounded_control_value(value: String, max_len: usize) -> Result<String, GatewayError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(GatewayError::BadRequest(
            "control audit action and target are required".to_string(),
        ));
    }
    if value.chars().count() > max_len {
        return Err(GatewayError::BadRequest(
            "control audit fields are too long".to_string(),
        ));
    }
    Ok(value)
}

fn bounded_control_summary(value: Option<String>) -> Result<Option<String>, GatewayError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > 400 {
        return Err(GatewayError::BadRequest(
            "control audit summary is too long".to_string(),
        ));
    }
    Ok(Some(value))
}

fn bounded_control_actor(value: Option<String>) -> Result<Option<String>, GatewayError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > 240 {
        return Err(GatewayError::BadRequest(
            "control audit actor fields are too long".to_string(),
        ));
    }
    Ok(Some(value))
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
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;

    // Audit data is tenant-wide, so the master key is always sufficient. Without
    // it, access is allowed ONLY under the zero-config dev posture (loopback peer,
    // no base auth, no mesh/fleet, no provisioned master key). The shared gate
    // (config/audit/budget-spend) owns this decision so it cannot drift.
    crate::api::config::require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        &headers,
        "Audit log access",
    )?;

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
        timestamp_from: params.from,
        timestamp_until: params.until,
        request_id: params.request_id,
        session_id: params.session_id,
        widget_instance_id: params.widget_instance_id,
        event_type: params.event_type,
        id_after: None,
    };

    let entries = state
        .audit
        .query(&query)
        .map_err(|e| GatewayError::Internal(anyhow::anyhow!("audit query failed: {e}")))?;

    // Enrich managed model-call rows with the provider-reported transaction cost
    // when one exists. The stored `provider_cost_micro_usd` remains the raw
    // upstream amount; the usage surface exposes the charged amount after the
    // provider-level billing policy so it stays aligned with the wallet debit.
    // Rows without a provider cost use the configured estimate as an explicit
    // fallback. BYOK, self-hosted, and local rows deliberately stay `null`.
    let per_1k = state.config.control_plane.cost_per_1k_micro_usd;
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|e| {
            let source = usage_source_for_provider(
                &e.provider,
                e.managed_inference,
                state.config.credits.enabled && state.config.credits.internal_secret.is_some(),
            );
            let raw_cost_micro_usd: Option<u64> = if source != "managed" {
                None
            } else {
                e.provider_cost_micro_usd.or_else(|| {
                    (per_1k > 0)
                        .then(|| estimate_cost_micro_usd(e.input_tokens, e.output_tokens, per_1k))
                })
            };
            let cost_micro_usd = raw_cost_micro_usd.map(|raw| {
                state
                    .config
                    .credits
                    .debit_amount_for_provider(Some(e.provider.as_str()), raw)
            });
            let mut v = serde_json::to_value(&e).unwrap_or_else(|_| json!({}));
            if let Value::Object(map) = &mut v {
                map.insert("cost_micro_usd".to_string(), json!(cost_micro_usd));
                map.insert("source".to_string(), json!(source));
            }
            v
        })
        .collect();

    Ok(Json(json!({
        "count": entries.len(),
        "entries": entries,
    })))
}

/// Canonical local usage analytics. SQLite performs the aggregation directly,
/// so this endpoint covers the full requested range without fetching or capping
/// raw audit rows.
pub async fn query_audit_usage(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<AuditUsageQueryParams>,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    crate::api::config::require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        &headers,
        "Audit usage access",
    )?;

    if !state.audit.is_enabled() {
        return Err(GatewayError::Internal(anyhow::anyhow!(
            "Audit logging is disabled on this gateway."
        )));
    }

    let from = DateTime::parse_from_rfc3339(&params.from)
        .map_err(|_| GatewayError::BadRequest("from must be an RFC 3339 timestamp".to_owned()))?;
    let until = DateTime::parse_from_rfc3339(&params.until)
        .map_err(|_| GatewayError::BadRequest("until must be an RFC 3339 timestamp".to_owned()))?;
    if until <= from {
        return Err(GatewayError::BadRequest(
            "until must be later than from".to_owned(),
        ));
    }
    if until.signed_duration_since(from) > ChronoDuration::days(400) {
        return Err(GatewayError::BadRequest(
            "usage analytics ranges cannot exceed 400 days".to_owned(),
        ));
    }

    let query = AuditUsageQuery {
        timestamp_from: params.from,
        timestamp_until: params.until,
        provider: params.provider,
        model: params.model,
    };
    let mut events = state.audit.usage_rollup(&query).map_err(|error| {
        GatewayError::Internal(anyhow::anyhow!("audit usage query failed: {error}"))
    })?;

    let managed_node =
        state.config.credits.enabled && state.config.credits.internal_secret.is_some();
    let per_1k = state.config.control_plane.cost_per_1k_micro_usd;
    for event in &mut events {
        event.source =
            usage_source_for_provider(&event.provider, event.managed_inference, managed_node)
                .to_owned();
        if event.source != "managed" {
            event.cost_micro_usd = None;
            continue;
        }
        let fallback = (per_1k > 0
            && (event.unpriced_input_tokens > 0 || event.unpriced_output_tokens > 0))
            .then(|| {
                estimate_cost_micro_usd(
                    event.unpriced_input_tokens,
                    event.unpriced_output_tokens,
                    per_1k,
                )
            });
        event.cost_micro_usd = match (event.cost_micro_usd, fallback) {
            (Some(reported), Some(estimated)) => Some(reported.saturating_add(estimated)),
            (Some(reported), None) => Some(reported),
            (None, Some(estimated)) => Some(estimated),
            (None, None) => None,
        };
    }

    Ok(Json(json!({
        "kind": "rollup",
        "bucketSeconds": 900,
        "events": events,
    })))
}

/// Record a successful gateway-local control mutation after the caller's
/// authenticated admin boundary has been enforced.
pub async fn record_control_change(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ControlAuditBody>,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    crate::api::config::require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        &headers,
        "Control audit writes",
    )?;

    let action = bounded_control_value(body.action, 120)?;
    let target = bounded_control_value(body.target, 120)?;
    let summary = bounded_control_summary(body.summary)?;
    let actor_id = bounded_control_actor(body.actor_id)?;
    let actor_name = bounded_control_actor(body.actor_name)?;
    if state.audit.is_enabled() {
        let actor = if ctx.is_master_key {
            actor_name.as_deref().unwrap_or("master-key")
        } else {
            actor_name.as_deref().unwrap_or("loopback-admin")
        };
        state.log_audit(AuditLogger::make_control_record(
            Uuid::new_v4().to_string(),
            ctx.api_key,
            actor.to_string(),
            actor_id,
            action,
            target,
            summary,
        ));
    }

    Ok(Json(json!({ "ok": true })))
}

/// Classify audit rows for the usage surface without treating every token
/// count as a credit debit. The provider id is the durable signal for the
/// donated managed slots; untagged vendor slots are the operator's own key.
fn usage_source_for_provider(
    provider: &str,
    managed_inference: bool,
    managed_node: bool,
) -> &'static str {
    let base_provider = provider.split(':').next().unwrap_or(provider);
    match base_provider {
        "local" | "ollama" | "llamacpp" | "lmstudio" | "vllm" => "local",
        "openrouter" => {
            if managed_inference {
                "managed"
            } else {
                "byok"
            }
        }
        "openai" | "anthropic" | "genai" => "byok",
        "cloudflare" | "bedrock" | "vertex" | "openai-credits"
            if managed_inference || managed_node =>
        {
            "managed"
        }
        _ if managed_inference => "managed",
        _ => "self_hosted",
    }
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

// ── Per-widget-instance rate limiter (Ryu Apps, §4.3) ────────────────────────
//
// A process-global rolling-minute token bucket per widget instance. It is a
// static rather than a field on `AppState` because it is self-contained
// governance that BOTH `check_exec_budget` (the pre-run gate) and the
// `exec_tool` widget chain (D5) consult, without threading new state through the
// whole app. Keyed by `"<kind>:<instance_id>"` so a widget's `callTool` and
// `sendFollowUpMessage` buckets are independent, and one rendered widget can
// never drain another's budget.

struct WidgetBucket {
    window_start: Instant,
    count: u32,
}

#[derive(Default)]
struct WidgetRateLimiter {
    buckets: DashMap<String, WidgetBucket>,
}

impl WidgetRateLimiter {
    /// Try to consume one token for `key` under `max_per_min`. Returns `true`
    /// when allowed (and records the use); `false` when this minute's budget is
    /// spent. `max_per_min == 0` ⇒ unlimited.
    fn try_consume(&self, key: String, max_per_min: u32) -> bool {
        if max_per_min == 0 {
            return true;
        }
        let mut bucket = self.buckets.entry(key).or_insert_with(|| WidgetBucket {
            window_start: Instant::now(),
            count: 0,
        });
        if bucket.window_start.elapsed() >= Duration::from_secs(60) {
            bucket.window_start = Instant::now();
            bucket.count = 0;
        }
        if bucket.count >= max_per_min {
            return false;
        }
        bucket.count += 1;
        true
    }
}

fn widget_limiter() -> &'static WidgetRateLimiter {
    static LIMITER: OnceLock<WidgetRateLimiter> = OnceLock::new();
    LIMITER.get_or_init(WidgetRateLimiter::default)
}

/// Consume one widget `callTool` token for `instance_id`. Returns `false` when
/// the per-instance per-minute call budget is spent. A disabled widget section
/// (`enabled = false`) or `max_calls_per_min == 0` is always allowed.
pub fn widget_call_allowed(cfg: &WidgetConfig, instance_id: &str) -> bool {
    if !cfg.enabled {
        return true;
    }
    widget_limiter().try_consume(format!("call:{instance_id}"), cfg.max_calls_per_min)
}

/// Consume one widget `sendFollowUpMessage` token for `instance_id` (stricter
/// than `callTool`). Returns `false` when the per-instance per-minute follow-up
/// budget is spent. Consumed by the follow-up authorization path (§4.2, gate 4);
/// exposed here as the single owner of the widget token buckets. `dead_code`
/// until the follow-up ingest handler wires it, so the bucket lives in one place.
#[allow(dead_code)]
pub fn widget_followup_allowed(cfg: &WidgetConfig, instance_id: &str) -> bool {
    if !cfg.enabled {
        return true;
    }
    widget_limiter().try_consume(format!("followup:{instance_id}"), cfg.max_followups_per_min)
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
            state.log_audit(record);
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
        state.log_audit(record);
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

    let result = state.exec_budget.check();
    let current_count = state.exec_budget.current_count();
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

#[cfg(test)]
mod tests {
    use super::{
        check_exec_budget, estimate_cost_micro_usd, ingest_exec_audit, query_audit,
        query_audit_usage, usage_source_for_provider, widget_call_allowed, widget_followup_allowed,
        AuditQueryParams, AuditUsageQueryParams, ExecAuditBody, ExecBudgetCheckBody,
        WidgetRateLimiter,
    };
    use crate::audit::{AuditLogger, AuditQuery, AuditRecord};
    use crate::config::{
        ApiKeyConfig, AuditConfig, AuthConfig, EvalsConfig, GatewayConfig, ProviderBillingMode,
        ProviderBillingPolicy, ProviderId,
    };
    use crate::error::GatewayError;
    use crate::evals::EvalsRunner;
    use crate::state::{AppState, SharedState};
    use crate::tools::exec::WidgetEnvelope;
    use axum::extract::{ConnectInfo, Query, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    fn unique_db_path() -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        std::env::temp_dir()
            .join(format!("ryu-gw-audit-test-{pid}-{n}.db"))
            .to_string_lossy()
            .to_string()
    }

    /// A trusted-forwarder key ("Core"), plus a plain untrusted key.
    fn trusted_key() -> ApiKeyConfig {
        ApiKeyConfig {
            key: "sk-core".to_string(),
            name: "core".to_string(),
            org_id: None,
            team_id: None,
            channel_id: None,
            project_id: None,
            requests_per_minute: None,
            tokens_per_minute: None,
            token_budget_total: None,
            downgrade_to: None,
            trusted_forwarder: true,
        }
    }

    fn plain_key() -> ApiKeyConfig {
        ApiKeyConfig {
            key: "sk-plain".to_string(),
            name: "plain".to_string(),
            trusted_forwarder: false,
            ..trusted_key()
        }
    }

    fn state_with(audit_enabled: bool) -> SharedState {
        state_with_credits(audit_enabled, false)
    }

    fn state_with_credits(audit_enabled: bool, managed_credits: bool) -> SharedState {
        let db_path = if audit_enabled {
            unique_db_path()
        } else {
            String::new()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: audit_enabled,
            db_path,
        })
        .expect("audit logger");
        let mut config = GatewayConfig {
            auth: AuthConfig {
                require_auth: true,
                master_key: Some("sk-master".to_string()),
                api_keys: vec![trusted_key(), plain_key()],
            },
            ..GatewayConfig::default()
        };
        if managed_credits {
            config.credits.enabled = true;
            config.credits.internal_secret = Some("test-internal-secret".to_string());
        }
        Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ))
    }

    fn bearer(key: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {key}").parse().unwrap());
        h
    }

    fn loopback() -> ConnectInfo<SocketAddr> {
        ConnectInfo("127.0.0.1:1".parse().unwrap())
    }

    // ── WidgetRateLimiter ─────────────────────────────────────────────────────

    #[test]
    fn widget_bucket_is_unlimited_at_zero_and_caps_at_max() {
        let limiter = WidgetRateLimiter::default();
        // 0 = unlimited: always allowed.
        assert!(limiter.try_consume("k0".to_string(), 0));
        assert!(limiter.try_consume("k0".to_string(), 0));
        // max=2: two allowed, the third denied within the same minute.
        assert!(limiter.try_consume("k2".to_string(), 2));
        assert!(limiter.try_consume("k2".to_string(), 2));
        assert!(!limiter.try_consume("k2".to_string(), 2));
        // A different key has its own independent budget.
        assert!(limiter.try_consume("other".to_string(), 2));
    }

    #[test]
    fn widget_call_and_followup_allowed_bypass_when_disabled() {
        let mut cfg = crate::config::WidgetConfig::default();
        cfg.enabled = false;
        // Disabled ⇒ always allowed regardless of the (unique) instance.
        assert!(widget_call_allowed(&cfg, "inst-disabled-call"));
        assert!(widget_followup_allowed(&cfg, "inst-disabled-followup"));

        // Enabled with a tiny follow-up budget ⇒ the (stricter) bucket exhausts.
        cfg.enabled = true;
        cfg.max_followups_per_min = 1;
        assert!(widget_followup_allowed(&cfg, "inst-strict"));
        assert!(!widget_followup_allowed(&cfg, "inst-strict"));
    }

    // ── ingest_exec_audit ─────────────────────────────────────────────────────

    fn exec_body() -> ExecAuditBody {
        ExecAuditBody {
            backend: "wasmtime".to_string(),
            command: "echo hi".to_string(),
            duration_ms: 42,
            exit_code: 0,
            session_id: Some("s1".to_string()),
            error: None,
            event_type: None,
        }
    }

    #[tokio::test]
    async fn ingest_exec_rejects_untrusted_keys() {
        let state = state_with(false);
        let res = ingest_exec_audit(State(state), bearer("sk-plain"), Json(exec_body())).await;
        assert!(
            matches!(res, Err(GatewayError::Unauthorized(_))),
            "a non-trusted key must not forge exec rows"
        );
    }

    #[tokio::test]
    async fn ingest_exec_records_and_advances_the_budget_counter() {
        let state = state_with(false);
        assert_eq!(state.exec_budget.current_count(), 0);
        let Json(body) = ingest_exec_audit(
            State(Arc::clone(&state)),
            bearer("sk-master"),
            Json(exec_body()),
        )
        .await
        .expect("master key may ingest");
        assert_eq!(body["ok"], true);
        assert_eq!(body["exec_count"], 1);
        assert_eq!(state.exec_budget.current_count(), 1);
    }

    #[tokio::test]
    async fn ingest_credential_read_does_not_drain_the_exec_budget() {
        let state = state_with(false);
        let mut b = exec_body();
        b.event_type = Some("credential_read".to_string());
        let Json(body) = ingest_exec_audit(State(Arc::clone(&state)), bearer("sk-core"), Json(b))
            .await
            .expect("trusted forwarder may ingest");
        assert_eq!(body["ok"], true);
        // A credential read is a distinct event and must NOT count against exec budget.
        assert_eq!(state.exec_budget.current_count(), 0);
    }

    // ── check_exec_budget ─────────────────────────────────────────────────────

    fn check_body(widget: Option<WidgetEnvelope>) -> ExecBudgetCheckBody {
        check_body_with_feature(widget, None)
    }

    fn check_body_with_feature(
        widget: Option<WidgetEnvelope>,
        feature: Option<&str>,
    ) -> ExecBudgetCheckBody {
        ExecBudgetCheckBody {
            backend: "wasmtime".to_string(),
            command: "echo".to_string(),
            feature: feature.map(str::to_owned),
            widget,
        }
    }

    #[tokio::test]
    async fn check_exec_budget_allows_under_default_unlimited_budget() {
        let state = state_with(false);
        let Json(resp) =
            check_exec_budget(State(state), bearer("sk-master"), Json(check_body(None)))
                .await
                .expect("master key");
        assert!(resp.allowed);
        assert!(resp.reason.is_none());
    }

    #[tokio::test]
    async fn check_exec_budget_rejects_untrusted_keys() {
        let state = state_with(false);
        let res = check_exec_budget(State(state), bearer("sk-plain"), Json(check_body(None))).await;
        assert!(matches!(res, Err(GatewayError::Unauthorized(_))));
    }

    #[tokio::test]
    async fn check_exec_budget_denies_a_widget_over_its_per_instance_rate() {
        // Drive the widget max_calls_per_min down to 1 so the second call denies.
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let mut config = GatewayConfig {
            auth: AuthConfig {
                require_auth: true,
                master_key: Some("sk-master".to_string()),
                api_keys: vec![],
            },
            ..GatewayConfig::default()
        };
        config.widget.enabled = true;
        config.widget.max_calls_per_min = 1;
        let state = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ));

        let envelope = || {
            Some(WidgetEnvelope {
                instance_id: "widget-rate-instance".to_string(),
                origin_server: "com.acme.app".to_string(),
            })
        };
        // First widget call is allowed.
        let Json(first) = check_exec_budget(
            State(Arc::clone(&state)),
            bearer("sk-master"),
            Json(check_body(envelope())),
        )
        .await
        .unwrap();
        assert!(first.allowed);
        // Second, same instance, same minute ⇒ denied with a rate-limit reason.
        let Json(second) = check_exec_budget(
            State(Arc::clone(&state)),
            bearer("sk-master"),
            Json(check_body(envelope())),
        )
        .await
        .unwrap();
        assert!(!second.allowed);
        assert!(second.reason.unwrap().contains("rate limit"));
    }

    #[tokio::test]
    async fn check_exec_budget_denies_a_widget_followup_over_its_per_instance_rate() {
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let mut config = GatewayConfig {
            auth: AuthConfig {
                require_auth: true,
                master_key: Some("sk-master".to_string()),
                api_keys: vec![],
            },
            ..GatewayConfig::default()
        };
        config.widget.enabled = true;
        config.widget.max_followups_per_min = 1;
        let state = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ));

        let envelope = || {
            Some(WidgetEnvelope {
                instance_id: "widget-followup-rate-instance".to_string(),
                origin_server: "com.acme.app".to_string(),
            })
        };
        let body = || check_body_with_feature(envelope(), Some("widget-followup"));
        let Json(first) =
            check_exec_budget(State(Arc::clone(&state)), bearer("sk-master"), Json(body()))
                .await
                .unwrap();
        assert!(first.allowed);

        let Json(second) = check_exec_budget(State(state), bearer("sk-master"), Json(body()))
            .await
            .unwrap();
        assert!(!second.allowed);
        assert!(second.reason.unwrap().contains("follow-up rate limit"));
    }

    // ── query_audit ───────────────────────────────────────────────────────────

    fn empty_params() -> Query<AuditQueryParams> {
        Query(serde_json::from_value(serde_json::json!({})).unwrap())
    }

    async fn wait_for_audit_entries(state: &SharedState, expected: usize) {
        let query = AuditQuery::default();
        for _ in 0..200 {
            let count = state.audit.query(&query).expect("audit query").len();
            if count >= expected {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("audit writer did not persist {expected} entries in time");
    }

    #[tokio::test]
    async fn query_audit_errors_when_logging_is_disabled() {
        let state = state_with(false);
        let res = query_audit(
            State(state),
            loopback(),
            bearer("sk-master"),
            empty_params(),
        )
        .await;
        assert!(
            matches!(res, Err(GatewayError::Internal(_))),
            "a disabled audit log must surface an error, not empty data"
        );
    }

    #[tokio::test]
    async fn query_audit_returns_rows_with_derived_cost() {
        let state = state_with_credits(true, true);
        // Log one model_call row, then let the background writer flush.
        state.log_audit(AuditRecord {
            request_id: "r1".to_string(),
            api_key: "sk-master".to_string(),
            user_name: None,
            org_id: None,
            team_id: None,
            project_id: None,
            provider: "openai-credits".to_string(),
            model: "gpt-4o".to_string(),
            input_tokens: 1000,
            output_tokens: 0,
            cache_hit: false,
            latency_ms: 5,
            eval_score: None,
            error: None,
            skill_ids: None,
            session_id: None,
            user_id: None,
            agent_id: None,
            feature: None,
            managed_inference: true,
            provider_cost_micro_usd: None,
            event_type: crate::audit::EventType::ModelCall,
            backend: None,
            command: None,
            duration_ms: None,
            exit_code: None,
            widget_instance_id: None,
        });
        // The writer is a background thread over a bounded channel; wait for the
        // row rather than depending on a fixed scheduler-dependent delay.
        wait_for_audit_entries(&state, 1).await;

        let Json(body) = query_audit(
            State(Arc::clone(&state)),
            loopback(),
            bearer("sk-master"),
            empty_params(),
        )
        .await
        .expect("master key may read the audit log");
        assert_eq!(body["count"], 1);
        // Derived cost at the default 2000/1k rate: 1000 tokens ⇒ 2000 micro-USD.
        assert_eq!(body["entries"][0]["cost_micro_usd"], 2000);
    }

    #[tokio::test]
    async fn query_audit_usage_returns_exact_rollup_cost_and_counts() {
        let state = state_with_credits(true, true);
        let mut record = AuditRecord {
            request_id: "usage-reported".to_owned(),
            api_key: "sk-master".to_owned(),
            user_name: None,
            org_id: Some("org-1".to_owned()),
            team_id: None,
            project_id: None,
            provider: "openrouter".to_owned(),
            model: "gpt-5".to_owned(),
            input_tokens: 100,
            output_tokens: 50,
            cache_hit: false,
            latency_ms: 25,
            eval_score: None,
            error: None,
            skill_ids: None,
            session_id: None,
            event_type: crate::audit::EventType::ModelCall,
            backend: None,
            command: None,
            duration_ms: None,
            exit_code: None,
            user_id: Some("member-1".to_owned()),
            agent_id: None,
            feature: Some("chat".to_owned()),
            managed_inference: true,
            provider_cost_micro_usd: Some(1_250),
            widget_instance_id: None,
        };
        state.log_audit(record.clone());
        record.request_id = "usage-fallback".to_owned();
        record.input_tokens = 10;
        record.output_tokens = 5;
        record.provider_cost_micro_usd = None;
        record.error = Some("provider failed".to_owned());
        state.log_audit(record);
        wait_for_audit_entries(&state, 2).await;

        let Json(body) = query_audit_usage(
            State(state),
            loopback(),
            bearer("sk-master"),
            Query(AuditUsageQueryParams {
                from: (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339(),
                until: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
                provider: Some("openrouter".to_owned()),
                model: Some("gpt-5".to_owned()),
            }),
        )
        .await
        .expect("usage rollup");

        assert_eq!(body["kind"], "rollup");
        assert_eq!(body["bucketSeconds"], 900);
        assert_eq!(body["events"].as_array().map(Vec::len), Some(1));
        assert_eq!(body["events"][0]["requestCount"], 2);
        assert_eq!(body["events"][0]["errorCount"], 1);
        assert_eq!(body["events"][0]["latencyTotalMs"], 50);
        assert_eq!(body["events"][0]["source"], "managed");
        assert_eq!(body["events"][0]["costMicroUsd"], 1280);
    }

    #[tokio::test]
    async fn query_audit_usage_rejects_ranges_over_400_days() {
        let result = query_audit_usage(
            State(state_with(true)),
            loopback(),
            bearer("sk-master"),
            Query(AuditUsageQueryParams {
                from: "2025-01-01T00:00:00Z".to_owned(),
                until: "2026-03-01T00:00:00Z".to_owned(),
                provider: None,
                model: None,
            }),
        )
        .await;
        assert!(matches!(result, Err(GatewayError::BadRequest(_))));
    }

    #[tokio::test]
    async fn query_audit_applies_global_markup_to_reported_provider_cost() {
        let mut state = state_with_credits(true, true);
        Arc::get_mut(&mut state)
            .expect("test state has one owner")
            .config
            .credits
            .markup_bps = 2000;
        state.log_audit(AuditRecord {
            request_id: "marked-up-provider".to_string(),
            api_key: "sk-master".to_string(),
            user_name: None,
            org_id: Some("org-1".to_string()),
            team_id: None,
            project_id: None,
            provider: "acme".to_string(),
            model: "gpt-4o".to_string(),
            input_tokens: 1000,
            output_tokens: 0,
            cache_hit: false,
            latency_ms: 5,
            eval_score: None,
            error: None,
            skill_ids: None,
            session_id: None,
            user_id: None,
            agent_id: None,
            feature: None,
            managed_inference: true,
            provider_cost_micro_usd: Some(1000),
            event_type: crate::audit::EventType::ModelCall,
            backend: None,
            command: None,
            duration_ms: None,
            exit_code: None,
            widget_instance_id: None,
        });
        wait_for_audit_entries(&state, 1).await;

        let Json(body) = query_audit(
            State(Arc::clone(&state)),
            loopback(),
            bearer("sk-master"),
            empty_params(),
        )
        .await
        .expect("master key may read the audit log");
        assert_eq!(body["entries"][0]["cost_micro_usd"], 1200);
    }

    #[tokio::test]
    async fn query_audit_returns_openrouter_transaction_cost_for_managed_rows() {
        let mut state = state_with_credits(true, true);
        let gateway_config = &mut Arc::get_mut(&mut state)
            .expect("test state has one owner")
            .config;
        gateway_config.credits.markup_bps = 2000;
        gateway_config.credits.provider_billing.insert(
            ProviderId::from("openrouter"),
            ProviderBillingPolicy {
                mode: ProviderBillingMode::PassThrough,
            },
        );
        state.log_audit(AuditRecord {
            request_id: "managed-openrouter".to_string(),
            api_key: "sk-master".to_string(),
            user_name: None,
            org_id: Some("org-1".to_string()),
            team_id: None,
            project_id: None,
            provider: "openrouter".to_string(),
            model: "openai/gpt-5.6-sol".to_string(),
            input_tokens: 1000,
            output_tokens: 0,
            cache_hit: false,
            latency_ms: 5,
            eval_score: None,
            error: None,
            skill_ids: None,
            session_id: None,
            user_id: None,
            agent_id: None,
            feature: None,
            managed_inference: true,
            provider_cost_micro_usd: Some(1250),
            event_type: crate::audit::EventType::ModelCall,
            backend: None,
            command: None,
            duration_ms: None,
            exit_code: None,
            widget_instance_id: None,
        });
        wait_for_audit_entries(&state, 1).await;

        let Json(body) = query_audit(
            State(Arc::clone(&state)),
            loopback(),
            bearer("sk-master"),
            empty_params(),
        )
        .await
        .expect("master key may read the audit log");
        assert_eq!(body["entries"][0]["source"], "managed");
        assert_eq!(body["entries"][0]["cost_micro_usd"], 1250);
    }

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

    #[test]
    fn usage_source_keeps_non_credit_traffic_distinct() {
        assert_eq!(usage_source_for_provider("local", false, true), "local");
        assert_eq!(usage_source_for_provider("ollama", false, true), "local");
        assert_eq!(usage_source_for_provider("openai", false, true), "byok");
        assert_eq!(
            usage_source_for_provider("openai-credits", false, true),
            "managed"
        );
        assert_eq!(
            usage_source_for_provider("openrouter", true, true),
            "managed"
        );
        assert_eq!(usage_source_for_provider("openrouter", false, true), "byok");
        assert_eq!(
            usage_source_for_provider("openrouter:embedding", true, true),
            "managed"
        );
        assert_eq!(
            usage_source_for_provider("custom-provider", false, false),
            "self_hosted"
        );
    }
}
