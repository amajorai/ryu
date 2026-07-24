//! Firewall check HTTP surface.
//!
//! `POST /v1/firewall/check` runs the gateway's existing [`FirewallScanner`]
//! over caller-supplied text for a requested set of guardrails and returns a
//! simple `{ allowed, reason }` verdict. It is the surface a Core workflow
//! `Guardrails` node calls so policy ("what is allowed") stays in the Gateway,
//! per the Core-vs-Gateway rule, instead of being reimplemented in Core.
//!
//! Like `governance::validate_grants`, this is a read-only computation over
//! caller-supplied data: it mutates no gateway state and exposes no secret, so
//! it is not behind the master-key admin gate that `config`/`audit` use.
//!
//! Check-name mapping: the requested guardrail names are mapped to the
//! scanner's categories before scanning, so a desktop-facing label like
//! `jailbreak` is honoured (it maps to the firewall's prompt-injection patterns)
//! rather than silently passing. `moderation` has no pattern set in the firewall
//! today, so it is accepted but not enforced (a documented no-op).

use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{audit::AuditRecord, error::GatewayError, state::SharedState};

/// Body accepted by `POST /v1/firewall/check`.
#[derive(Debug, Deserialize)]
pub struct FirewallCheckRequest {
    /// The text to scan.
    #[serde(default)]
    pub text: String,
    /// Guardrails to enforce (e.g. `["pii", "jailbreak"]`). Unknown/unenforced
    /// names (such as `moderation`) are ignored.
    #[serde(default)]
    pub checks: Vec<String>,
}

/// Response from `POST /v1/firewall/check`.
#[derive(Debug, Serialize)]
pub struct FirewallCheckResponse {
    /// `true` when no requested guardrail tripped.
    pub allowed: bool,
    /// Human-readable reason populated on a block (the tripped category +
    /// pattern name); `None` when allowed.
    pub reason: Option<String>,
}

/// Map caller-facing guardrail names to the categories the firewall scanner
/// understands (`pii`, `secret(s)`, `prompt_injection`/`injection`). `jailbreak`
/// is a friendlier alias for the injection patterns. `moderation` has no backing
/// pattern set today, so it maps to nothing (accepted but not enforced).
fn map_checks(checks: &[String]) -> Vec<String> {
    let mut mapped: Vec<String> = Vec::new();
    for c in checks {
        match c.to_ascii_lowercase().as_str() {
            "pii" => mapped.push("pii".to_string()),
            "secret" | "secrets" => mapped.push("secret".to_string()),
            "jailbreak" | "injection" | "prompt_injection" => {
                mapped.push("prompt_injection".to_string());
            }
            // `moderation`/`toxicity` now map to the real Toxicity detector so a
            // Core workflow Guardrails node gets a genuine (lexical) check instead
            // of a silent no-op. The authoritative judgment remains the toxicity
            // evaluator's LLM-judge path on the chat pipeline.
            "moderation" | "toxicity" => mapped.push("toxicity".to_string()),
            "bias" | "bias_fairness" => mapped.push("bias".to_string()),
            "code_injection" => mapped.push("code_injection".to_string()),
            // Any unknown name has no backing pattern set; not enforced rather
            // than faked.
            _ => {}
        }
    }
    mapped
}

/// POST /v1/firewall/check — scan `text` for the requested guardrails.
///
/// This endpoint stays ungated (read-only over caller text), but a trip is now
/// written to the audit log so a Core workflow Guardrails block is as observable
/// as the pipeline's inline firewall/inspector blocks (P2 #3). The `authorization`
/// bearer, when present, only *attributes* the audit row — it is never required,
/// so the endpoint's auth posture is unchanged.
pub async fn firewall_check(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<FirewallCheckRequest>,
) -> Result<Json<FirewallCheckResponse>, GatewayError> {
    let mapped = map_checks(&req.checks);

    // No enforceable guardrails requested → allow (e.g. only `moderation`).
    if mapped.is_empty() {
        return Ok(Json(FirewallCheckResponse {
            allowed: true,
            reason: None,
        }));
    }

    let hit = state.with_firewall(|fw| fw.scan_locked_guardrails(&req.text, &mapped));

    match hit {
        Some(m) => {
            let kind = m.kind.as_str();
            tracing::info!(
                kind = %kind,
                pattern = %m.pattern_name,
                "firewall check: guardrail tripped"
            );
            let reason = format!("{kind} guardrail tripped ({})", m.pattern_name);
            audit_firewall_check_block(&state, &headers, kind, &m.pattern_name);
            Ok(Json(FirewallCheckResponse {
                allowed: false,
                reason: Some(reason),
            }))
        }
        None => Ok(Json(FirewallCheckResponse {
            allowed: true,
            reason: None,
        })),
    }
}

/// Write an audit record when a `POST /v1/firewall/check` guardrail trips,
/// mirroring the pipeline's `audit_inspector_block` shape (provider/backend tag,
/// `error` carrying the tripped category + pattern). Like every other audit
/// writer this is a no-op when audit logging is disabled. The bearer is read
/// only to attribute the row (stripped of the `Bearer ` prefix, as
/// `authenticate` does); an absent bearer is labelled `firewall-check`.
fn audit_firewall_check_block(state: &SharedState, headers: &HeaderMap, kind: &str, pattern: &str) {
    if !state.audit.is_enabled() {
        return;
    }
    let api_key = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|k| k.strip_prefix("Bearer ").unwrap_or(k).to_string())
        .unwrap_or_else(|| "firewall-check".to_string());

    state.audit.log(AuditRecord {
        request_id: Uuid::new_v4().to_string(),
        api_key,
        user_name: None,
        org_id: None,
        team_id: None,
        project_id: None,
        provider: "firewall".to_string(),
        model: "firewall-check".to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_hit: false,
        latency_ms: 0,
        eval_score: None,
        error: Some(format!("firewall check blocked: {kind} ({pattern})")),
        skill_ids: None,
        session_id: None,
        user_id: None,
        agent_id: None,
        feature: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: Some("firewall".to_string()),
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_jailbreak_to_injection() {
        assert_eq!(
            map_checks(&["jailbreak".to_string()]),
            vec!["prompt_injection".to_string()]
        );
    }

    #[test]
    fn maps_pii_and_secrets_straight_through() {
        assert_eq!(map_checks(&["pii".to_string()]), vec!["pii".to_string()]);
        assert_eq!(
            map_checks(&["secrets".to_string()]),
            vec!["secret".to_string()]
        );
    }

    #[test]
    fn moderation_and_toxicity_map_to_toxicity() {
        assert_eq!(
            map_checks(&["moderation".to_string()]),
            vec!["toxicity".to_string()]
        );
        assert_eq!(
            map_checks(&["toxicity".to_string()]),
            vec!["toxicity".to_string()]
        );
    }

    #[test]
    fn unknown_maps_to_nothing() {
        assert!(map_checks(&["bogus".to_string()]).is_empty());
    }
}
