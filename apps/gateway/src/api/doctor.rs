//! Gateway configuration, security, and performance diagnostics.
//!
//! The report consumes resolved local state and is read-only. The separate fix
//! endpoint only applies the small set of idempotent protective changes
//! explicitly marked as safe by a finding. Core augments the report with its
//! own approval and agent-routing preferences before exposing it to the desktop.

use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    extract::{ConnectInfo, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    config::{ExecBudgetAction, FirewallConfig, GatewayConfig},
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

#[derive(Debug, Clone, Serialize)]
pub struct DoctorFinding {
    #[serde(rename = "checkId")]
    pub check_id: String,
    pub category: String,
    pub severity: String,
    pub summary: String,
    pub detail: String,
    #[serde(rename = "settingPath", skip_serializing_if = "Option::is_none")]
    pub setting_path: Option<String>,
    #[serde(rename = "recommendedAction", skip_serializing_if = "Option::is_none")]
    pub recommended_action: Option<String>,
    #[serde(rename = "canAutoFix")]
    pub can_auto_fix: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DoctorCounts {
    pub errors: usize,
    pub warnings: usize,
    pub info: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorReport {
    #[serde(rename = "schemaVersion")]
    pub schema_version: &'static str,
    #[serde(rename = "rulesetVersion")]
    pub ruleset_version: &'static str,
    pub profile: &'static str,
    #[serde(rename = "readOnly")]
    pub read_only: bool,
    #[serde(rename = "generatedAt")]
    pub generated_at: u64,
    pub posture: String,
    pub counts: DoctorCounts,
    pub findings: Vec<DoctorFinding>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct DoctorFixRequest {
    #[serde(rename = "dryRun", default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorFix {
    #[serde(rename = "checkId")]
    pub check_id: String,
    #[serde(rename = "settingPath")]
    pub setting_path: String,
    pub summary: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorFixResult {
    #[serde(rename = "dryRun")]
    pub dry_run: bool,
    #[serde(rename = "plannedFixes")]
    pub planned_fixes: Vec<DoctorFix>,
    #[serde(rename = "appliedFixes")]
    pub applied_fixes: Vec<DoctorFix>,
    pub report: DoctorReport,
}

fn finding(
    check_id: &str,
    category: &str,
    severity: &str,
    summary: &str,
    detail: impl Into<String>,
    setting_path: Option<&str>,
    recommended_action: Option<&str>,
) -> DoctorFinding {
    DoctorFinding {
        check_id: check_id.to_owned(),
        category: category.to_owned(),
        severity: severity.to_owned(),
        summary: summary.to_owned(),
        detail: detail.into(),
        setting_path: setting_path.map(str::to_owned),
        recommended_action: recommended_action.map(str::to_owned),
        can_auto_fix: false,
    }
}

fn fixable_finding(
    check_id: &str,
    category: &str,
    severity: &str,
    summary: &str,
    detail: impl Into<String>,
    setting_path: Option<&str>,
    recommended_action: Option<&str>,
) -> DoctorFinding {
    let mut result = finding(
        check_id,
        category,
        severity,
        summary,
        detail,
        setting_path,
        recommended_action,
    );
    result.can_auto_fix = true;
    result
}

fn fix_for_finding(finding: &DoctorFinding) -> Option<DoctorFix> {
    let (setting_path, action) = match finding.check_id.as_str() {
        "security.firewall-disabled" => (
            "firewall.enabled",
            "Enable the Gateway firewall while preserving the current policy.",
        ),
        "security.partial-firewall-scan" => (
            "firewall.scan_inbound + firewall.scan_outbound",
            "Enable both inbound and outbound firewall scanning.",
        ),
        "security.redaction-disabled" => (
            "firewall.redact_pii + firewall.redact_secrets",
            "Enable PII and secret redaction.",
        ),
        "security.untrusted-results-unwrapped" => (
            "firewall.wrap_untrusted_tool_results",
            "Wrap untrusted tool results before they re-enter model context.",
        ),
        _ => return None,
    };
    Some(DoctorFix {
        check_id: finding.check_id.clone(),
        setting_path: setting_path.to_owned(),
        summary: finding.summary.clone(),
        action: action.to_owned(),
    })
}

fn planned_fixes(report: &DoctorReport) -> Vec<DoctorFix> {
    report
        .findings
        .iter()
        .filter(|finding| finding.can_auto_fix)
        .filter_map(fix_for_finding)
        .collect()
}

fn firewall_with_safe_fixes(state: &SharedState, report: &DoctorReport) -> Option<FirewallConfig> {
    let current = state.with_firewall(|firewall| firewall.config().clone());
    let mut next = current.clone();
    for finding in report
        .findings
        .iter()
        .filter(|finding| finding.can_auto_fix)
    {
        match finding.check_id.as_str() {
            "security.firewall-disabled" => next.enabled = true,
            "security.partial-firewall-scan" => {
                next.scan_inbound = true;
                next.scan_outbound = true;
            }
            "security.redaction-disabled" => {
                next.redact_pii = true;
                next.redact_secrets = true;
            }
            "security.untrusted-results-unwrapped" => {
                next.wrap_untrusted_tool_results = true;
            }
            _ => {}
        }
    }
    (next != current).then_some(next)
}

fn is_loopback_bind(bind: &str) -> bool {
    let host = bind
        .rsplit_once(':')
        .map_or(bind, |(host, _)| host)
        .trim_matches(['[', ']']);
    host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

fn provider_configured(config: &GatewayConfig, provider: &str) -> bool {
    match provider {
        "openai" => config.providers.openai.is_some(),
        "anthropic" => config.providers.anthropic.is_some(),
        "local" => config.providers.local.is_some(),
        "classify" => config.providers.classify.is_some(),
        "openrouter" => config.providers.openrouter.is_some(),
        "litellm" => config.providers.litellm.is_some(),
        "core" => config.providers.core.is_some(),
        "modal" => config.providers.modal.is_some(),
        "genai" => config.providers.genai.is_some(),
        "replicate" => config.providers.replicate.is_some(),
        "fal" => config.providers.fal.is_some(),
        "cloudflare" => config.providers.cloudflare.is_some(),
        "bedrock" => config.providers.bedrock.is_some(),
        "vertex" => config.providers.vertex.is_some(),
        "openai-credits" => config.providers.openai_credits.is_some(),
        "anthropic-credits" => config.providers.anthropic_credits.is_some(),
        _ => false,
    }
}

fn any_chat_provider_configured(config: &GatewayConfig) -> bool {
    let providers = &config.providers;
    providers.openai.is_some()
        || providers.anthropic.is_some()
        || providers.local.is_some()
        || providers.openrouter.is_some()
        || providers.litellm.is_some()
        || providers.core.is_some()
        || providers.modal.is_some()
        || providers.genai.is_some()
        || providers.replicate.is_some()
        || providers.fal.is_some()
        || providers.cloudflare.is_some()
        || providers.bedrock.is_some()
        || providers.vertex.is_some()
        || providers.openai_credits.is_some()
        || providers.anthropic_credits.is_some()
}

fn drift_path(code: &str) -> Option<&'static str> {
    match code {
        "exec_without_firewall" | "locked_guardrails_firewall_off" => Some("firewall.enabled"),
        "composio_guardrails_advisory" => Some("composio.actions"),
        "exec_budget_stop_ineffective" => Some("exec_budget.action"),
        "secret_redaction_disabled" => Some("firewall.redact_secrets"),
        _ => None,
    }
}

fn push_drift_findings(findings: &mut Vec<DoctorFinding>, state: &SharedState) {
    let firewall = state.with_firewall(|fw| fw.config().clone());
    let drift = crate::policy::detect_drift(
        &state.config.tools,
        &state.config.composio,
        &state.config.exec_budget,
        &firewall,
        &state.policy_snapshot(),
    );

    for warning in drift {
        let severity = if warning.severity == "high" {
            "error"
        } else {
            "warning"
        };
        findings.push(finding(
            &warning.code,
            "security",
            severity,
            "Policy settings contradict each other",
            warning.message,
            drift_path(&warning.code),
            Some("Open the affected Gateway setting and resolve the contradiction."),
        ));
    }
}

fn collect_findings(state: &SharedState) -> Vec<DoctorFinding> {
    let mut findings = Vec::new();
    let firewall: FirewallConfig = state.with_firewall(|fw| fw.config().clone());
    let bind_is_loopback = is_loopback_bind(&state.config.bind);
    let auth_required = state.with_auth(|auth| auth.require_auth);

    if let Some(path) = GatewayConfig::config_path().filter(|path| path.exists()) {
        if let Err(error) = GatewayConfig::load() {
            findings.push(finding(
                "configuration.load-failed",
                "configuration",
                "error",
                "Gateway configuration could not be loaded",
                format!(
                    "The running process may be using startup defaults because {} could not be read: {error}",
                    path.display()
                ),
                None,
                Some("Fix the configuration file, then restart Gateway."),
            ));
        }

        // Gateway configuration can contain provider endpoints and auth metadata.
        // Keep this diagnostic-only and platform-aware: the safe repair boundary
        // deliberately does not chmod a file that may be intentionally shared by
        // an operator-managed service account.
        #[cfg(unix)]
        if let Ok(metadata) = std::fs::metadata(&path) {
            use std::os::unix::fs::PermissionsExt;

            let mode = metadata.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                findings.push(finding(
                    "security.config-permissions",
                    "security",
                    "warning",
                    "Gateway configuration is readable by other users",
                    format!(
                        "{} has mode {:o}; provider and auth metadata should normally be readable only by the Gateway account.",
                        path.display(),
                        mode
                    ),
                    Some("gateway.toml.permissions"),
                    Some("Restrict gateway.toml to the Gateway account (usually mode 0600) after checking service ownership."),
                ));
            }
        }
    }

    if !bind_is_loopback && !auth_required {
        findings.push(finding(
            "security.exposed-without-auth",
            "security",
            "error",
            "Gateway is exposed without authentication",
            format!(
                "Gateway is bound to {} but auth is disabled. This would expose provider credentials and billable traffic to the network.",
                state.config.bind
            ),
            Some("bind"),
            Some("Bind Gateway to loopback or enable authentication before exposing it."),
        ));
    }

    if !firewall.enabled && (state.config.tools.enabled || state.config.composio.enabled) {
        findings.push(fixable_finding(
            "security.firewall-disabled",
            "security",
            "error",
            "Tool execution is running without the firewall",
            "Gateway tools or Composio are enabled while inbound and outbound DLP inspection is disabled.",
            Some("firewall.enabled"),
            Some("Enable the firewall before using tool or Composio execution."),
        ));
    }

    if !firewall.scan_inbound || !firewall.scan_outbound {
        findings.push(fixable_finding(
            "security.partial-firewall-scan",
            "security",
            "warning",
            "Firewall scanning is only partially enabled",
            format!(
                "Inbound scanning is {}; outbound scanning is {}.",
                if firewall.scan_inbound { "on" } else { "off" },
                if firewall.scan_outbound { "on" } else { "off" }
            ),
            Some("firewall.scan_inbound"),
            Some("Keep both inbound and outbound scanning enabled unless you have a documented exception."),
        ));
    }

    if !firewall.redact_secrets || !firewall.redact_pii {
        findings.push(fixable_finding(
            "security.redaction-disabled",
            "security",
            "warning",
            "Sensitive-data redaction is incomplete",
            format!(
                "Secret redaction is {}; PII redaction is {}.",
                if firewall.redact_secrets { "on" } else { "off" },
                if firewall.redact_pii { "on" } else { "off" }
            ),
            Some("firewall.redact_secrets"),
            Some("Enable secret and PII redaction to keep detected sensitive data out of forwarded content."),
        ));
    }

    if !firewall.wrap_untrusted_tool_results {
        findings.push(fixable_finding(
            "security.untrusted-results-unwrapped",
            "security",
            "warning",
            "Untrusted tool results are not wrapped",
            "External tool output can re-enter model context without boundary markers.",
            Some("firewall.wrap_untrusted_tool_results"),
            Some("Enable untrusted tool-result wrapping."),
        ));
    }

    let stages: Vec<&str> = state
        .stage_order
        .stages()
        .iter()
        .map(|stage| stage.as_str())
        .collect();
    if !stages.contains(&"firewall") {
        findings.push(finding(
            "security.firewall-stage-missing",
            "security",
            "error",
            "Firewall stage is missing from the running pipeline",
            "The active request pipeline does not contain the firewall stage.",
            Some("pipeline"),
            Some("Restore the default pipeline order and restart Gateway."),
        ));
    }
    if state.config.audit.enabled && !stages.contains(&"audit") {
        findings.push(finding(
            "security.audit-stage-missing",
            "security",
            "warning",
            "Audit stage is missing from the running pipeline",
            "Audit is enabled in configuration but is not present in the active pipeline order.",
            Some("pipeline"),
            Some("Restore the default pipeline order and restart Gateway."),
        ));
    }

    if !state.config.rate_limit.enabled {
        findings.push(finding(
            "performance.rate-limit-disabled",
            "performance",
            if bind_is_loopback { "info" } else { "warning" },
            "Rate limiting is disabled",
            "Requests are not protected by the Gateway's per-key rate limiter.",
            Some("rate_limit.enabled"),
            Some("Enable rate limiting for exposed or shared nodes."),
        ));
    } else if !bind_is_loopback
        && (state.config.rate_limit.requests_per_minute.is_none()
            || state.config.rate_limit.tokens_per_minute.is_none())
    {
        findings.push(finding(
            "security.exposed-without-rate-limits",
            "security",
            "warning",
            "Exposed Gateway has an unbounded rate-limit dimension",
            "At least one global request or token rate limit is unlimited on a non-loopback bind.",
            Some("rate_limit"),
            Some("Set both request and token limits for an exposed Gateway."),
        ));
    }

    if !state.config.concurrency.enabled || state.config.concurrency.local_max_in_flight == 0 {
        findings.push(finding(
            "performance.local-concurrency-unbounded",
            "performance",
            "warning",
            "Local-engine concurrency is unbounded",
            "The local inference admission queue is disabled or has no in-flight ceiling, which can increase memory pressure during bursts.",
            Some("concurrency"),
            Some("Enable local concurrency limits and keep a bounded queue."),
        ));
    }

    if !state.config.circuit_breaker.enabled {
        findings.push(finding(
            "performance.circuit-breaker-disabled",
            "performance",
            "warning",
            "Provider circuit breakers are disabled",
            "Repeated upstream failures can continue consuming request capacity without a fast-open circuit.",
            Some("circuit_breaker.enabled"),
            Some("Enable circuit breakers unless the node has an external equivalent."),
        ));
    }

    let default_provider = state.config.routing.default_provider.as_str();
    if !provider_configured(&state.config, default_provider) {
        findings.push(finding(
            "connectivity.default-provider-missing",
            "connectivity",
            "warning",
            "The default route has no configured provider",
            format!(
                "Routing selects provider `{default_provider}`, but that provider is not configured on this Gateway."
            ),
            Some("routing.default_provider"),
            Some("Configure the selected provider or choose one that is available."),
        ));
    }

    if !any_chat_provider_configured(&state.config) {
        findings.push(finding(
            "connectivity.no-provider-configured",
            "connectivity",
            "warning",
            "No chat provider is configured",
            "Gateway can start, but chat requests will fail until a local, hosted, or Core provider is configured.",
            Some("providers"),
            Some("Open Providers and configure at least one chat provider."),
        ));
    }

    if firewall.inspector.enabled && state.config.providers.classify.is_none() {
        findings.push(finding(
            "connectivity.inspector-provider-missing",
            "connectivity",
            "warning",
            "The traffic inspector has no classifier provider",
            "Inspector failures are fail-open because no classify provider is available.",
            Some("firewall.inspector.model"),
            Some("Start or configure a classifier provider, or turn off the inspector."),
        ));
    }

    if state.config.exec_budget.action == ExecBudgetAction::Stop
        && state.config.exec_budget.max_count == 0
        && state.config.exec_budget.max_wall_clock_secs == 0
    {
        findings.push(finding(
            "security.exec-budget-stop-ineffective",
            "security",
            "warning",
            "Execution stop budget has no limit",
            "The execution budget is configured to stop work, but both execution limits are unlimited.",
            Some("exec_budget"),
            Some("Set max_count or max_wall_clock_secs, or change the action to notify."),
        ));
    }

    push_drift_findings(&mut findings, state);

    findings.sort_by(|left, right| {
        fn rank(severity: &str) -> u8 {
            match severity {
                "error" => 0,
                "warning" => 1,
                _ => 2,
            }
        }
        rank(&left.severity)
            .cmp(&rank(&right.severity))
            .then_with(|| left.check_id.cmp(&right.check_id))
    });
    findings
}

fn report_for(state: &SharedState) -> DoctorReport {
    let findings = collect_findings(state);
    let mut counts = DoctorCounts::default();
    for finding in &findings {
        match finding.severity.as_str() {
            "error" => counts.errors += 1,
            "warning" => counts.warnings += 1,
            _ => counts.info += 1,
        }
    }
    let generated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    DoctorReport {
        schema_version: "1",
        ruleset_version: "gateway-1",
        profile: "lint",
        read_only: true,
        generated_at,
        posture: "gateway-only".to_owned(),
        counts,
        findings,
    }
}

/// Return a redacted, deterministic local doctor report.
pub async fn get_doctor(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<DoctorReport>, GatewayError> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    super::config::require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        &headers,
        "Doctor access",
    )?;
    Ok(Json(report_for(&state)))
}

/// Apply only the protective, idempotent fixes explicitly marked by this report.
/// Dry-run returns the same plan without writing or hot-swapping any state.
pub async fn fix_doctor(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<DoctorFixRequest>,
) -> Result<Json<DoctorFixResult>, GatewayError> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    super::config::require_local_admin(&state, &peer, ctx.is_master_key, &headers, "Doctor fixes")?;

    let before = report_for(&state);
    let planned = planned_fixes(&before);
    let mut applied = Vec::new();

    if !request.dry_run {
        if let Some(firewall) = firewall_with_safe_fixes(&state, &before) {
            let patch = super::config::ConfigPatch {
                composio_billing: None,
                expected_revision: None,
                provider_account_policies: None,
                provider_account_strategies: None,
                provider_account_drain_thresholds: None,
                acp: None,
                computer_use: None,
                firewall: Some(firewall),
                budgets: None,
                auth: None,
                routing: None,
                egress: None,
                tools: None,
                firewall_org_overlays: None,
                firewall_agent_overlays: None,
                custom_evaluators: None,
                backends: None,
                resolved_backends: None,
                screening: None,
                marketplace_recommendations: None,
                phone_calls: None,
            };
            let _ = super::config::put_config(
                State(state.clone()),
                ConnectInfo(peer),
                headers,
                Json(patch),
            )
            .await?;
            applied = planned.clone();
        }
    }

    let report = if request.dry_run {
        before
    } else {
        report_for(&state)
    };
    Ok(Json(DoctorFixResult {
        dry_run: request.dry_run,
        planned_fixes: planned,
        applied_fixes: applied,
        report,
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        any_chat_provider_configured, fix_for_finding, fixable_finding, is_loopback_bind,
        provider_configured,
    };
    use crate::config::GatewayConfig;
    use serde_json::json;

    #[test]
    fn bind_detection_accepts_loopback_hosts() {
        assert!(is_loopback_bind("127.0.0.1:7981"));
        assert!(is_loopback_bind("[::1]:7981"));
        assert!(is_loopback_bind("localhost:7981"));
        assert!(!is_loopback_bind("0.0.0.0:7981"));
        assert!(!is_loopback_bind("192.168.1.20:7981"));
    }

    #[test]
    fn only_allowlisted_protective_findings_have_repairs() {
        let safe = fixable_finding(
            "security.redaction-disabled",
            "security",
            "warning",
            "Redaction is incomplete",
            "PII redaction is disabled.",
            Some("firewall.redact_pii"),
            Some("Enable redaction."),
        );
        let unsafe_finding = fixable_finding(
            "security.config-permissions",
            "security",
            "warning",
            "Permissions need review",
            "The file is readable by other users.",
            Some("gateway.toml.permissions"),
            Some("Review service ownership first."),
        );

        assert_eq!(
            fix_for_finding(&safe).map(|fix| fix.setting_path),
            Some("firewall.redact_pii + firewall.redact_secrets".to_owned())
        );
        assert!(fix_for_finding(&unsafe_finding).is_none());
    }

    #[test]
    fn provider_checks_cover_the_full_gateway_registry() {
        let mut config = GatewayConfig::default();
        config.providers = serde_json::from_value(json!({
            "openai": { "api_key": "sk-o" },
            "anthropic": { "api_key": "sk-a" },
            "local": { "base_url": "http://127.0.0.1:1234" },
            "openrouter": { "api_key": "sk-or" },
            "litellm": { "api_key": "sk-litellm" },
            "core": { "base_url": "http://127.0.0.1:7979", "token": "t" },
            "modal": { "api_key": "sk-m", "base_url": "https://modal.example" },
            "genai": { "keys": { "gemini": "sk-g" } },
            "replicate": { "api_key": "sk-r" },
            "fal": { "api_key": "sk-f" },
            "classify": { "base_url": "http://127.0.0.1:8083/v1" },
            "cloudflare": { "api_key": "cf", "base_url": "https://cf.example/ai/v1" },
            "bedrock": { "api_key": "aws", "base_url": "https://bedrock.example/anthropic" },
            "vertex": { "api_key": "gcp", "base_url": "https://vertex.example/endpoints/openapi" },
            "openai_credits": { "api_key": "sk-donated" }
        }))
        .expect("all registered provider shapes parse");

        for provider in [
            "openai",
            "anthropic",
            "local",
            "classify",
            "openrouter",
            "litellm",
            "core",
            "modal",
            "genai",
            "replicate",
            "fal",
            "cloudflare",
            "bedrock",
            "vertex",
            "openai-credits",
        ] {
            assert!(
                provider_configured(&config, provider),
                "provider {provider}"
            );
        }
        assert!(any_chat_provider_configured(&config));
    }
}

#[cfg(test)]
#[path = "doctor_fix_tests.rs"]
mod fix_tests;
