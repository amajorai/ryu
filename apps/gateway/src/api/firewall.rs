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

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::{error::GatewayError, state::SharedState};

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
            // `moderation` (and any unknown name) has no firewall pattern set; it
            // is intentionally not enforced rather than faked.
            _ => {}
        }
    }
    mapped
}

/// POST /v1/firewall/check — scan `text` for the requested guardrails.
pub async fn firewall_check(
    State(state): State<SharedState>,
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
            let kind = match m.kind {
                crate::firewall::DetectionKind::Pii => "pii",
                crate::firewall::DetectionKind::Secret => "secret",
                crate::firewall::DetectionKind::PromptInjection => "prompt_injection",
            };
            tracing::info!(
                kind = %kind,
                pattern = %m.pattern_name,
                "firewall check: guardrail tripped"
            );
            Ok(Json(FirewallCheckResponse {
                allowed: false,
                reason: Some(format!("{kind} guardrail tripped ({})", m.pattern_name)),
            }))
        }
        None => Ok(Json(FirewallCheckResponse {
            allowed: true,
            reason: None,
        })),
    }
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
    fn moderation_and_unknown_map_to_nothing() {
        assert!(map_checks(&["moderation".to_string()]).is_empty());
        assert!(map_checks(&["bogus".to_string()]).is_empty());
    }
}
