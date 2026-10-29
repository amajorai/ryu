//! Organization tool policy (C2) at the Gateway's own tool-execution points.
//!
//! The control plane resolves `allowedTools`, `deniedTools` and
//! `allowedMcpServers` into every effective policy it hands out. Core enforces
//! them at its MCP/tool dispatch boundary, but the Gateway's legacy Composio
//! loop executes actions directly (no Core catalog), so the Gateway must apply
//! the same decision itself: otherwise an organization's tool denials would not
//! reach that data plane. The unified loop applies it too, as defence in depth.
//!
//! The evaluator is a port of Core's `org_policy::evaluate_tool`
//! (`apps/core/src/org_policy.rs`): every entry is an ASCII case-insensitive
//! glob (`*` any run, `?` one character) matched against the canonical
//! `server.tool` id or the MCP server id; a deny match always wins, and a
//! non-empty allowlist denies everything it does not match. Both
//! implementations replay `crates/gateway/contracts/fixtures/org-tool-policy-v1.json`
//! so they cannot drift.

use std::sync::Arc;

use super::EffectivePolicy;

/// Called once per denied tool call with `(tool_id, reason)`, so the pipeline
/// can write an `org_policy.tool_denied` audit row attributed to the request.
pub type ToolDenialAudit = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// ASCII case-insensitive glob match: `*` matches any run (including `.` and
/// `/`), `?` matches exactly one character. Everything else is literal. Same
/// semantics as Core's `org_policy::glob_match`.
pub fn tool_glob_match(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().map(|c| c.to_ascii_lowercase()).collect();
    let value: Vec<char> = value.chars().map(|c| c.to_ascii_lowercase()).collect();
    let (mut p, mut v) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut star_value = 0usize;
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            star_value = v;
            p += 1;
        } else if let Some(star_at) = star {
            p = star_at + 1;
            star_value += 1;
            v = star_value;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

fn first_match<'a>(patterns: &'a [String], value: &str) -> Option<&'a str> {
    patterns
        .iter()
        .map(|pattern| pattern.trim())
        .find(|pattern| usable(pattern) && tool_glob_match(pattern, value))
}

/// Core's wire cleaning drops blank and over-long (> 512 byte) entries.
fn usable(pattern: &str) -> bool {
    !pattern.is_empty() && pattern.len() <= 512
}

fn has_entries(patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| usable(pattern.trim()))
}

impl EffectivePolicy {
    /// Evaluate one tool call against the organization's tool rules. `Err`
    /// carries the caller-facing denial reason. An unavailable policy (never
    /// resolved for this caller, or refused) denies every tool.
    pub fn evaluate_tool(&self, tool_id: &str, mcp_server: Option<&str>) -> Result<(), String> {
        if !self.available {
            return Err(format!(
                "tool '{tool_id}' is denied: your organization's tool policy is unavailable"
            ));
        }
        if let Some(pattern) = first_match(&self.denied_tools, tool_id) {
            return Err(format!(
                "tool '{tool_id}' is denied by your organization's tool policy (rule '{pattern}')"
            ));
        }
        if let Some(server) = mcp_server {
            if has_entries(&self.allowed_mcp_servers)
                && first_match(&self.allowed_mcp_servers, server).is_none()
            {
                return Err(format!(
                    "MCP server '{server}' is not in your organization's allowed MCP servers"
                ));
            }
        }
        if has_entries(&self.allowed_tools) && first_match(&self.allowed_tools, tool_id).is_none() {
            return Err(format!(
                "tool '{tool_id}' is not in your organization's allowed tools"
            ));
        }
        Ok(())
    }
}

/// The organization tool policy one request's tool loop enforces. The default
/// gate enforces nothing (master key, or a test without policy).
#[derive(Clone, Default)]
pub struct OrgToolGate {
    policy: Option<Arc<EffectivePolicy>>,
    audit: Option<ToolDenialAudit>,
}

impl std::fmt::Debug for OrgToolGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrgToolGate")
            .field("enforced", &self.policy.is_some())
            .field("audited", &self.audit.is_some())
            .finish()
    }
}

impl OrgToolGate {
    /// Enforce `policy`'s tool rules, reporting each denial to `audit`.
    pub fn new(policy: EffectivePolicy, audit: Option<ToolDenialAudit>) -> Self {
        Self {
            policy: Some(Arc::new(policy)),
            audit,
        }
    }

    /// Whether `tool_id` may be offered to the model. Never audits: listing is
    /// not an attempt.
    pub fn permits(&self, tool_id: &str) -> bool {
        self.policy
            .as_deref()
            .is_none_or(|policy| policy.evaluate_tool(tool_id, None).is_ok())
    }

    /// Decide one tool call. A denial is reported to the audit hook and its
    /// reason returned for the tool-result envelope.
    ///
    /// The Gateway cannot tell an external MCP server from a built-in one, so
    /// it evaluates the tool globs only (`mcp_server = None`, as Core does for
    /// built-in plugins such as Composio); Core applies `allowedMcpServers` at
    /// its own dispatch boundary.
    pub fn check(&self, tool_id: &str) -> Result<(), String> {
        let Some(policy) = self.policy.as_deref() else {
            return Ok(());
        };
        policy.evaluate_tool(tool_id, None).inspect_err(|reason| {
            tracing::warn!(tool = tool_id, %reason, "tool call denied by the organization tool policy");
            if let Some(audit) = &self.audit {
                audit(tool_id, reason);
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const FIXTURE: &str =
        include_str!("../../../../crates/gateway/contracts/fixtures/org-tool-policy-v1.json");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        #[serde(default)]
        rules: FixtureRules,
        tool: String,
        #[serde(default)]
        mcp_server: Option<String>,
        allow: bool,
    }

    #[derive(Default, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureRules {
        #[serde(default)]
        allowed_tools: Vec<String>,
        #[serde(default)]
        denied_tools: Vec<String>,
        #[serde(default)]
        allowed_mcp_servers: Vec<String>,
    }

    #[test]
    fn evaluator_matches_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture json");
        let cases: Vec<Case> =
            serde_json::from_value(fixture["cases"].clone()).expect("fixture cases");
        assert!(!cases.is_empty());
        for case in cases {
            let policy = EffectivePolicy {
                allowed_tools: case.rules.allowed_tools,
                denied_tools: case.rules.denied_tools,
                allowed_mcp_servers: case.rules.allowed_mcp_servers,
                ..EffectivePolicy::default()
            };
            assert_eq!(
                policy
                    .evaluate_tool(&case.tool, case.mcp_server.as_deref())
                    .is_ok(),
                case.allow,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn unavailable_policy_denies_every_tool() {
        let policy = EffectivePolicy {
            available: false,
            ..EffectivePolicy::default()
        };
        assert!(policy
            .evaluate_tool("composio.GMAIL_GET_MESSAGE", None)
            .is_err());
    }

    #[test]
    fn gate_audits_denials_but_not_listing() {
        let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let sink = Arc::clone(&seen);
        let gate = OrgToolGate::new(
            EffectivePolicy {
                denied_tools: vec!["composio.*".into()],
                ..EffectivePolicy::default()
            },
            Some(Arc::new(move |tool: &str, reason: &str| {
                sink.lock()
                    .unwrap()
                    .push((tool.to_owned(), reason.to_owned()));
            })),
        );
        assert!(!gate.permits("composio.GMAIL_SEND_EMAIL"));
        assert!(gate.permits("exa.search"));
        assert!(seen.lock().unwrap().is_empty(), "listing never audits");
        let reason = gate.check("composio.GMAIL_SEND_EMAIL").unwrap_err();
        assert_eq!(
            reason,
            "tool 'composio.GMAIL_SEND_EMAIL' is denied by your organization's tool policy (rule 'composio.*')"
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(gate.check("exa.search").is_ok());
        assert!(OrgToolGate::default()
            .check("composio.GMAIL_SEND_EMAIL")
            .is_ok());
    }
}
