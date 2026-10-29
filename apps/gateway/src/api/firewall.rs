//! Firewall check HTTP surface.
//!
//! `POST /v1/firewall/check` runs the gateway's per-request resolved
//! [`FirewallScanner`] (the same node → org → agent cascade the chat path uses)
//! over caller-supplied text for a requested set of guardrails and returns a
//! simple `{ allowed, reason }` verdict. It is the surface a Core workflow
//! `Guardrails` node calls so policy ("what is allowed") stays in the Gateway,
//! per the Core-vs-Gateway rule, instead of being reimplemented in Core.
//!
//! Callers authenticate before scanning or writing attributed audit records.
//!
//! Check-name mapping: the requested guardrail names are mapped to the
//! scanner's categories before scanning, so a desktop-facing label like
//! `jailbreak` is honoured (it maps to the firewall's prompt-injection patterns)
//! rather than silently passing. `moderation` has no pattern set in the firewall
//! today, so it is accepted but not enforced (a documented no-op).

use axum::{extract::State, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};

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
/// A trip is written with the verified caller identity. Authentication precedes
/// scanning, including requests with no enforceable checks.
pub async fn firewall_check(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<FirewallCheckRequest>,
) -> Result<Json<FirewallCheckResponse>, GatewayError> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let ctx = crate::pipeline::authenticate(&state, crate::pipeline::AuthInputs::with_key(raw_key))
        .await?;
    let mapped = map_checks(&req.checks);

    // No enforceable guardrails requested → allow (e.g. only `moderation`).
    if mapped.is_empty() {
        return Ok(Json(FirewallCheckResponse {
            allowed: true,
            reason: None,
        }));
    }

    // The same per-request resolved scanner (node → org → agent, plus any
    // request overlay) the chat path uses, so overlay custom patterns apply here.
    let hit = state
        .resolved_scanner(&ctx)
        .scan_locked_guardrails(&req.text, &mapped);

    match hit {
        Some(m) => {
            let kind = m.kind.as_str();
            tracing::info!(
                kind = %kind,
                pattern = %m.pattern_name,
                "firewall check: guardrail tripped"
            );
            let reason = format!("{kind} guardrail tripped ({})", m.pattern_name);
            audit_firewall_check_block(&state, &ctx, kind, &m.pattern_name);
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
/// writer this is a no-op when audit logging is disabled. Identity is taken
/// only from the authenticated request context, never an unverified header.
fn audit_firewall_check_block(
    state: &SharedState,
    ctx: &crate::pipeline::RequestContext,
    kind: &str,
    pattern: &str,
) {
    if !state.audit.is_enabled() {
        return;
    }
    let api_key = ctx.api_key.clone();

    state.log_audit(AuditRecord {
        // The authenticated context claimed the HTTP request's id, so the
        // audit row matches the response's `x-request-id`.
        request_id: ctx.request_id.clone(),
        api_key,
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        team_ids: ctx.audit_team_ids(),
        key_id: ctx.key_id(),
        project_id: ctx.project_id.clone(),
        provider: "firewall".to_string(),
        model: "firewall-check".to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: 0,
        eval_score: None,
        error: Some(format!("firewall check blocked: {kind} ({pattern})")),
        skill_ids: None,
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: None,
        purpose: None,
        managed_inference: false,
        provider_cost_micro_usd: None,
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

    #[tokio::test]
    async fn the_block_audit_row_carries_the_response_request_id() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let dir = tempfile::tempdir().unwrap();
        let audit_config = crate::config::AuditConfig {
            enabled: true,
            db_path: dir
                .path()
                .join("audit.sqlite")
                .to_string_lossy()
                .into_owned(),
        };
        let key = "gateway-firewall-reqid-0123456789abcdef";
        let mut cfg = crate::config::GatewayConfig::default();
        cfg.audit = audit_config.clone();
        cfg.auth.api_keys =
            vec![serde_json::from_value(serde_json::json!({"key":key,"name":"scanner"})).unwrap()];
        let state = std::sync::Arc::new(crate::state::AppState::new_for_test(
            cfg,
            crate::audit::AuditLogger::new(&audit_config).unwrap(),
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        ));
        let response = crate::api::router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/firewall/check")
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"text":"user@example.com","checks":["pii"]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let request_id = response
            .headers()
            .get(crate::api::http_conventions::REQUEST_ID_HEADER)
            .expect("x-request-id")
            .to_str()
            .unwrap()
            .to_owned();
        for _ in 0..200 {
            let rows = state
                .audit
                .query(&crate::audit::AuditQuery::default())
                .unwrap();
            if let Some(row) = rows.first() {
                assert_eq!(row.request_id, request_id);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("firewall block was not persisted");
    }

    #[tokio::test]
    async fn firewall_rejects_forged_audit_identity_and_records_verified_caller() {
        let path =
            std::env::temp_dir().join(format!("ryu-firewall-auth-{}.sqlite", uuid::Uuid::new_v4()));
        let audit_config = crate::config::AuditConfig {
            enabled: true,
            db_path: path.to_string_lossy().into_owned(),
        };
        let key = "gateway-firewall-test-0123456789abcdef";
        let mut cfg = crate::config::GatewayConfig::default();
        cfg.audit = audit_config.clone();
        cfg.auth.api_keys =
            vec![
                serde_json::from_value(serde_json::json!({"key":key,"name":"verified-scanner"}))
                    .unwrap(),
            ];
        let state = std::sync::Arc::new(crate::state::AppState::new_for_test(
            cfg,
            crate::audit::AuditLogger::new(&audit_config).unwrap(),
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        ));
        for credential in [None, Some("forged-victim-key"), Some(key)] {
            let mut headers = HeaderMap::new();
            if let Some(credential) = credential {
                headers.insert(
                    "authorization",
                    format!("Bearer {credential}").parse().unwrap(),
                );
            }
            let result = firewall_check(
                State(state.clone()),
                headers,
                Json(FirewallCheckRequest {
                    text: "user@example.com".into(),
                    checks: vec!["pii".into()],
                }),
            )
            .await;
            if credential == Some(key) {
                assert!(!result.unwrap().0.allowed);
            } else {
                assert!(matches!(result, Err(GatewayError::Unauthorized(_))));
            }
        }
        for _ in 0..200 {
            let rows = state
                .audit
                .query(&crate::audit::AuditQuery::default())
                .unwrap();
            if !rows.is_empty() {
                assert_eq!(
                    rows.len(),
                    1,
                    "rejected credentials cannot poison the audit log"
                );
                assert_ne!(
                    rows[0].api_key, key,
                    "audit storage does not expose the bearer"
                );
                let attributed = state
                    .audit
                    .query(&crate::audit::AuditQuery {
                        api_key: Some(key.into()),
                        ..Default::default()
                    })
                    .unwrap();
                assert_eq!(attributed.len(), 1);
                assert!(state
                    .audit
                    .query(&crate::audit::AuditQuery {
                        api_key: Some("forged-victim-key".into()),
                        ..Default::default()
                    })
                    .unwrap()
                    .is_empty());
                assert_eq!(rows[0].user_name.as_deref(), Some("verified-scanner"));
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("verified firewall block was not persisted");
    }

    /// An org overlay's custom pattern applies to `/v1/firewall/check` exactly as
    /// it does on the chat path; the node-base scanner alone would miss it.
    #[tokio::test]
    async fn check_uses_the_resolved_scanner_with_overlay_custom_patterns() {
        let mut cfg = crate::config::GatewayConfig::default();
        cfg.auth.require_auth = false;
        let state = std::sync::Arc::new(crate::state::AppState::new_for_test(
            cfg,
            crate::audit::AuditLogger::new(&crate::config::AuditConfig {
                enabled: false,
                db_path: String::new(),
            })
            .unwrap(),
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        ));
        state.set_policy(crate::policy::EffectivePolicy {
            firewall: Some(crate::config::FirewallOverlay {
                custom_patterns: vec![crate::config::CustomPattern {
                    name: "acme_internal_id".into(),
                    regex: r"ACME-\d{6}".into(),
                    kind: crate::config::CustomPatternKind::Pii,
                }],
                ..Default::default()
            }),
            ..crate::policy::EffectivePolicy::default()
        });
        let response = firewall_check(
            State(state),
            HeaderMap::new(),
            Json(FirewallCheckRequest {
                text: "ticket ACME-123456".into(),
                checks: vec!["pii".into()],
            }),
        )
        .await
        .expect("no-auth check is accepted");
        assert!(
            !response.0.allowed,
            "the overlay pattern must trip the check"
        );
        assert!(response
            .0
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("acme_internal_id")));
    }

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
