//! Passthrough audit rows and pre-forward refusals.

use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use tracing::warn;

use super::WireFormat;
use crate::{audit::AuditRecord, state::SharedState};

/// Refuse a passthrough request before it is forwarded: audit the refusal and
/// return 403 with the reason.
pub(super) fn refuse_request(
    state: &SharedState,
    format: WireFormat,
    model: &str,
    started: std::time::Instant,
    reason: String,
    (user_id, agent_id, feature): (Option<String>, Option<String>, Option<String>),
) -> Response {
    warn!(provider = provider_label(format), %reason, "passthrough: request refused");
    state.metrics.inc_firewall_blocked();
    emit_audit(
        state,
        format,
        model,
        started.elapsed().as_millis() as u64,
        Some(reason.clone()),
        user_id,
        agent_id,
        feature,
    );
    (StatusCode::FORBIDDEN, reason).into_response()
}

/// Read an optional non-empty header value as an owned string. Mirrors the
/// `x-ryu-*` tag extraction used on the chat path so passthrough audit rows carry
/// the same control-plane attribution.
pub(super) fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// A short, format-specific provider label for audit rows.
pub(super) fn provider_label(format: WireFormat) -> &'static str {
    match format {
        WireFormat::Anthropic => "anthropic-passthrough",
        WireFormat::OpenAiResponses => "codex-passthrough",
    }
}

pub(super) fn emit_audit(
    state: &SharedState,
    format: WireFormat,
    model: &str,
    latency_ms: u64,
    error: Option<String>,
    user_id: Option<String>,
    agent_id: Option<String>,
    feature: Option<String>,
) {
    state.log_audit(AuditRecord {
        key_id: None,
        request_id: format!(
            "pt-{}-{}",
            provider_label(format),
            chrono::Utc::now().timestamp_millis()
        ),
        api_key: "passthrough".to_string(),
        user_name: None,
        org_id: None,
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: provider_label(format).to_string(),
        model: model.to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms,
        eval_score: None,
        error,
        skill_ids: None,
        session_id: None,
        user_id,
        agent_id,
        feature,
        purpose: None,
        managed_inference: false,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}
