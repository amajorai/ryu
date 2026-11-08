use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
    Json,
};
use chrono::{DateTime, Duration as ChronoDuration};
use serde::Deserialize;
use serde_json::{json, Value};

use super::usage_cost::{estimate_cost_micro_usd, usage_source_for_provider};
use crate::{
    audit::{AuditQuery, AuditUsageQuery},
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
    /// Inclusive lower bound for the ISO/UTC timestamp range.
    pub from: Option<String>,
    /// Exclusive upper bound for the ISO/UTC timestamp range.
    pub until: Option<String>,
    /// Filter by gateway-internal request id (M4 / #176).
    pub request_id: Option<String>,
    /// Filter by Core session/conversation id (M4 / #176).
    pub session_id: Option<String>,
    /// Filter by the stable agent id forwarded by Core.
    pub agent_id: Option<String>,
    /// Filter by widget instance id (Ryu Apps, §4.4).
    pub widget_instance_id: Option<String>,
    /// Filter by event discriminator, including `control_change`.
    pub event_type: Option<String>,
    /// Filter by the verified user id Core forwarded for the call.
    pub user_id: Option<String>,
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
    /// Restrict the rollup to one background-feature purpose (`x-ryu-purpose`).
    #[serde(default)]
    pub purpose: Option<String>,
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
        agent_id: params.agent_id,
        widget_instance_id: params.widget_instance_id,
        event_type: params.event_type,
        user_id: params.user_id,
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
            } else if e.event_type == "service_call" {
                // Service costs cannot be reconstructed from model/token prices.
                // A missing stored provider amount stays unknown; the safe usage
                // metadata separately preserves estimate/source provenance.
                e.provider_cost_micro_usd
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
        purpose: params.purpose,
    };
    // The rollup scans up to 400 days of rows; keep it off the async worker.
    let rollup_state = state.clone();
    let mut events = tokio::task::spawn_blocking(move || rollup_state.audit.usage_rollup(&query))
        .await
        .map_err(|error| {
            GatewayError::Internal(anyhow::anyhow!("audit usage task failed: {error}"))
        })?
        .map_err(|error| {
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

/// Apply the local audit retention policy immediately. The normal startup path
/// runs this automatically; the endpoint gives an owner an explicit maintenance
/// control without exposing the SQLite file or allowing arbitrary SQL.
pub async fn prune_audit(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
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
        "Audit maintenance",
    )?;
    let summary = state
        .audit
        .prune()
        .map_err(|error| GatewayError::Internal(anyhow::anyhow!("audit prune failed: {error}")))?;
    Ok(Json(json!({
        "kind": "retention",
        "deleted_rows": summary.deleted_rows,
        "retention_days": summary.retention_days,
        "max_rows": summary.max_rows,
    })))
}
