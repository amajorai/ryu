//! Static policy-drift detection (dangerous-tool-combo + elevation drift).
//!
//! OpenClaw flags dangerous misconfigurations at policy-eval time: e.g. shell/exec
//! enabled while filesystem-mutation is denied, or `security="full"` (approvals
//! skipped) without compensating allowlists. The Ryu gateway has no approval /
//! elevation / security-level config of its own (interactive approval lives in a
//! different crate, `apps/core/src/sidecar/mcp/sandbox.rs`). What the gateway DOES
//! own is the effective tool-policy surface: tool-execution enablement
//! (`ToolsConfig`, `ComposioConfig`), the exec/sandbox budget (`ExecBudgetConfig`),
//! the DLP firewall (`FirewallConfig`), and the distributed `EffectivePolicy`.
//!
//! `detect_drift` maps OpenClaw's concepts onto that surface and returns a list of
//! drift warnings. Every rule here is a CONTRADICTION rule: a control is enabled
//! while its compensating control is defeated. None of them fire on the stock
//! defaults (`GatewayConfig::default()` + `EffectivePolicy::default()`) — that
//! invariant is locked by a mandatory unit test, so the detector never trains
//! operators to ignore a warning that trips out of the box.
//!
//! This is warn-only and pure: nothing is blocked. The result is logged with
//! `warn!` at startup (see `main.rs`) and surfaced via `GET /v1/config`.

use serde::Serialize;

use super::EffectivePolicy;
use crate::config::{
    ComposioConfig, ExecBudgetAction, ExecBudgetConfig, FirewallConfig, FirewallPolicy, ToolsConfig,
};

/// A single policy-drift warning. Output-only: serialized into `GET /v1/config`
/// and emitted via `warn!`. No `Deserialize` — nothing accepts these as input.
#[derive(Debug, Clone, Serialize)]
pub struct DriftWarning {
    /// Stable machine-readable identifier for the rule (e.g. `"exec_without_firewall"`).
    pub code: String,
    /// Free-form severity label (`"high"` / `"medium"`). Advisory; not load-bearing.
    pub severity: String,
    /// Human-readable explanation of the contradiction.
    pub message: String,
}

impl DriftWarning {
    fn new(code: &str, severity: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            severity: severity.to_string(),
            message: message.into(),
        }
    }
}

/// Inspect the effective tool policy and return any drift warnings.
///
/// The inputs are decomposed (the specific config slices, not `&GatewayConfig`)
/// so the API path can pass the LIVE firewall config read from the `RwLock`,
/// which is the only hot-swappable input. `tools` / `composio` / `exec_budget`
/// are startup snapshots and are not live-swappable, so passing them from
/// `state.config` is accurate.
///
/// Every rule is a contradiction rule and returns nothing on the stock defaults.
pub fn detect_drift(
    tools: &ToolsConfig,
    composio: &ComposioConfig,
    exec_budget: &ExecBudgetConfig,
    firewall: &FirewallConfig,
    policy: &EffectivePolicy,
) -> Vec<DriftWarning> {
    let mut warnings = Vec::new();

    // R1: a tool / code execution surface is live while the DLP firewall is off.
    if (tools.enabled || composio.enabled) && !firewall.enabled {
        warnings.push(DriftWarning::new(
            "exec_without_firewall",
            "high",
            "Tool execution is enabled but the DLP firewall is disabled: tool inputs and outputs flow with no inspection.",
        ));
    }

    // R2: Composio tool execution is on with an empty action allowlist, so every
    // Composio action is permitted (wildcard).
    if composio.enabled && composio.actions.is_empty() {
        warnings.push(DriftWarning::new(
            "composio_wildcard_allowlist",
            "high",
            "Composio tool execution is enabled with an empty action allowlist: every Composio action is permitted.",
        ));
    }

    // R3: external Composio tools can execute while the firewall is advisory-only
    // (detections are logged but never blocked or sanitized).
    if composio.enabled && firewall.enabled && firewall.policy == FirewallPolicy::WarnAndContinue {
        warnings.push(DriftWarning::new(
            "composio_guardrails_advisory",
            "medium",
            "External Composio tools can execute while the firewall policy is warn-and-continue: detections are logged but never blocked or sanitized.",
        ));
    }

    // R4: the operator chose the hard-stop exec-budget action but set no limits,
    // so Stop can never trigger.
    if exec_budget.action == ExecBudgetAction::Stop
        && exec_budget.max_count == 0
        && exec_budget.max_wall_clock_secs == 0
    {
        warnings.push(DriftWarning::new(
            "exec_budget_stop_ineffective",
            "medium",
            "Exec budget action is set to stop but both max_count and max_wall_clock_secs are 0: the hard stop can never trigger.",
        ));
    }

    // R5 (elevation-drift / approvals-skipped analog): the org-distributed policy
    // mandates locked guardrails but the local firewall is disabled.
    if policy.requires_firewall() && !firewall.enabled {
        warnings.push(DriftWarning::new(
            "locked_guardrails_firewall_off",
            "high",
            "The distributed policy requires locked guardrails but the local firewall is disabled: the mandated guardrails are not enforced.",
        ));
    }

    // R6: sanitize mode is chosen but secret redaction is turned off, so secrets
    // pass through unredacted.
    if firewall.enabled && firewall.policy == FirewallPolicy::Sanitize && !firewall.redact_secrets {
        warnings.push(DriftWarning::new(
            "secret_redaction_disabled",
            "high",
            "Firewall policy is sanitize but secret redaction is disabled: detected secrets are not redacted.",
        ));
    }

    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(warnings: &[DriftWarning]) -> Vec<&str> {
        warnings.iter().map(|w| w.code.as_str()).collect()
    }

    #[test]
    fn defaults_produce_no_drift() {
        // MANDATORY: every rule is a contradiction rule, so the stock defaults
        // must return an empty Vec. This guards against a fires-on-default
        // detector that trains operators to ignore the warning.
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &ComposioConfig::default(),
            &ExecBudgetConfig::default(),
            &FirewallConfig::default(),
            &EffectivePolicy::default(),
        );
        assert!(
            warnings.is_empty(),
            "expected no drift on defaults, got: {warnings:?}"
        );
    }

    #[test]
    fn r1_exec_without_firewall() {
        let firewall = FirewallConfig {
            enabled: false,
            ..Default::default()
        };
        // tools.enabled is true by default.
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &ComposioConfig::default(),
            &ExecBudgetConfig::default(),
            &firewall,
            &EffectivePolicy::default(),
        );
        assert!(codes(&warnings).contains(&"exec_without_firewall"));
    }

    #[test]
    fn r2_composio_wildcard_allowlist() {
        let composio = ComposioConfig {
            enabled: true,
            actions: Vec::new(),
            ..Default::default()
        };
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &composio,
            &ExecBudgetConfig::default(),
            &FirewallConfig::default(),
            &EffectivePolicy::default(),
        );
        assert!(codes(&warnings).contains(&"composio_wildcard_allowlist"));

        // A non-empty allowlist does NOT trip the wildcard rule.
        let scoped = ComposioConfig {
            enabled: true,
            actions: vec!["GITHUB_CREATE_ISSUE".to_string()],
            ..Default::default()
        };
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &scoped,
            &ExecBudgetConfig::default(),
            &FirewallConfig::default(),
            &EffectivePolicy::default(),
        );
        assert!(!codes(&warnings).contains(&"composio_wildcard_allowlist"));
    }

    #[test]
    fn r3_composio_guardrails_advisory() {
        let composio = ComposioConfig {
            enabled: true,
            actions: vec!["GITHUB_CREATE_ISSUE".to_string()],
            ..Default::default()
        };
        // Firewall enabled (default) + WarnAndContinue set explicitly — the R3
        // rule fires only for the advisory-only warn policy, which is no longer the
        // firewall default (that is now Block), so it must be opted into here.
        let firewall = FirewallConfig {
            policy: FirewallPolicy::WarnAndContinue,
            ..Default::default()
        };
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &composio,
            &ExecBudgetConfig::default(),
            &firewall,
            &EffectivePolicy::default(),
        );
        assert!(codes(&warnings).contains(&"composio_guardrails_advisory"));
    }

    #[test]
    fn r4_exec_budget_stop_ineffective() {
        let exec_budget = ExecBudgetConfig {
            action: ExecBudgetAction::Stop,
            max_count: 0,
            max_wall_clock_secs: 0,
            ..Default::default()
        };
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &ComposioConfig::default(),
            &exec_budget,
            &FirewallConfig::default(),
            &EffectivePolicy::default(),
        );
        assert!(codes(&warnings).contains(&"exec_budget_stop_ineffective"));

        // A real limit makes Stop effective, so no warning.
        let bounded = ExecBudgetConfig {
            action: ExecBudgetAction::Stop,
            max_count: 10,
            max_wall_clock_secs: 0,
            ..Default::default()
        };
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &ComposioConfig::default(),
            &bounded,
            &FirewallConfig::default(),
            &EffectivePolicy::default(),
        );
        assert!(!codes(&warnings).contains(&"exec_budget_stop_ineffective"));
    }

    #[test]
    fn r5_locked_guardrails_firewall_off() {
        let policy = EffectivePolicy {
            locked_guardrails: vec!["pii".to_string()],
            ..Default::default()
        };
        let firewall = FirewallConfig {
            enabled: false,
            ..Default::default()
        };
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &ComposioConfig::default(),
            &ExecBudgetConfig::default(),
            &firewall,
            &policy,
        );
        assert!(codes(&warnings).contains(&"locked_guardrails_firewall_off"));
    }

    #[test]
    fn r6_secret_redaction_disabled() {
        let firewall = FirewallConfig {
            enabled: true,
            policy: FirewallPolicy::Sanitize,
            redact_secrets: false,
            ..Default::default()
        };
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &ComposioConfig::default(),
            &ExecBudgetConfig::default(),
            &firewall,
            &EffectivePolicy::default(),
        );
        assert!(codes(&warnings).contains(&"secret_redaction_disabled"));

        // With secret redaction on, sanitize mode is consistent: no warning.
        let redacting = FirewallConfig {
            enabled: true,
            policy: FirewallPolicy::Sanitize,
            redact_secrets: true,
            ..Default::default()
        };
        let warnings = detect_drift(
            &ToolsConfig::default(),
            &ComposioConfig::default(),
            &ExecBudgetConfig::default(),
            &redacting,
            &EffectivePolicy::default(),
        );
        assert!(!codes(&warnings).contains(&"secret_redaction_disabled"));
    }
}
