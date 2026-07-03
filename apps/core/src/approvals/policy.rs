//! Approval policy: does an agent's tool call require human-in-the-loop approval?
//!
//! Three layers, composed with logical **OR** (any layer that says "gate" gates
//! the call):
//!
//!   - **Layer A — per-agent allowlist.** `AgentRecord.approval_tools` lists the
//!     exact tool ids this agent must get approval for. Core orchestration config
//!     (same shape as the skills allowlist / identity binding).
//!   - **Layer B — global mode + risk tags.** The `approval-mode` preference
//!     (`off` / `smart` / `manual`), Hermes-style:
//!       - `off`    → Layer B never gates (Layers A/C may still).
//!       - `manual` → every tool call is gated.
//!       - `smart`  → only tool calls classified *risky* are gated.
//!   - **Layer C — Gateway consult.** The authoritative moat layer: the Gateway
//!     may force approval (budget/org policy). Fail-**open** (an unreachable
//!     gateway never blocks a call), mirroring how the `Guardrails` node defers
//!     to the firewall. Lives in [`consult_gateway`]; the call site ORs it in.
//!
//! ## Risk classification
//!
//! `smart` mode needs to know which tools are "risky". The honest signal is an
//! explicit per-tool risk annotation, but not every tool carries one, so this
//! module also matches the tool id's **action segment** against a curated list
//! of clearly destructive / outbound verbs (send, delete, pay, deploy, …). A
//! false positive only adds an approval prompt; a false negative (a dangerous
//! tool that isn't matched) is the real cost, so the list errs toward inclusion
//! for genuinely irreversible or outbound actions — but deliberately excludes
//! broad read-ish verbs (get/list/search/read) to avoid gating everything.

/// Preference key for the global approval mode (`off` / `smart` / `manual`).
pub const APPROVAL_MODE_PREF: &str = "approval-mode";

/// The global approval mode (Layer B).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalMode {
    /// Layer B gates nothing (the default). Layers A and C may still gate.
    Off,
    /// Layer B gates only tool calls classified risky (see [`classify_risk`]).
    Smart,
    /// Layer B gates every tool call.
    Manual,
}

impl ApprovalMode {
    /// Parse the pref string; anything unrecognized (incl. empty/absent) is `Off`.
    pub fn from_pref(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "manual" => ApprovalMode::Manual,
            "smart" => ApprovalMode::Smart,
            _ => ApprovalMode::Off,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalMode::Off => "off",
            ApprovalMode::Smart => "smart",
            ApprovalMode::Manual => "manual",
        }
    }
}

/// Curated risk substrings matched against a tool id's action segment. Kept to
/// clearly destructive / irreversible / outbound verbs; broad read verbs are
/// intentionally absent so `smart` mode doesn't gate ordinary reads.
const RISKY_PATTERNS: &[&str] = &[
    "send",
    "delete",
    "remove",
    "destroy",
    "drop",
    "pay",
    "purchase",
    "buy",
    "transfer",
    "wire",
    "charge",
    "refund",
    "publish",
    "deploy",
    "release",
    "rotate",
    "revoke",
    "grant",
    "uninstall",
    "shutdown",
    "reboot",
    "kill",
    "email",
    "sms",
    "message",
    "post",
    "tweet",
    "merge",
    "force_push",
];

/// The action segment of a tool id: the part after the last `__`
/// (`<server>__<tool>` → `<tool>`), lowercased. Falls back to the whole id.
fn action_segment(tool_id: &str) -> String {
    tool_id
        .rsplit("__")
        .next()
        .unwrap_or(tool_id)
        .to_ascii_lowercase()
}

/// Risk tags for a tool id (empty ⇒ not classified risky by the name heuristic).
/// A caller with an explicit risk annotation should prefer that; this is the
/// name-based fallback.
pub fn classify_risk(tool_id: &str) -> Vec<String> {
    let action = action_segment(tool_id);
    RISKY_PATTERNS
        .iter()
        .filter(|p| action.contains(*p))
        .map(|p| (*p).to_owned())
        .collect()
}

/// Layers **A + B** (Core-local, pure, synchronous — the fast path). Returns
/// `Some(risk_tags)` when the call must be gated, `None` when the Core-local
/// layers permit it (Layer C, the Gateway consult, is ORed in separately by the
/// async caller). `agent_approval_tools` is the calling agent's
/// `approval_tools`; pass `&[]` when the caller is agent-less.
pub fn should_require_approval_local(
    agent_approval_tools: &[String],
    tool_id: &str,
    mode: ApprovalMode,
) -> Option<Vec<String>> {
    // Layer A: this agent explicitly gates this tool.
    if agent_approval_tools.iter().any(|t| t == tool_id) {
        let mut tags = classify_risk(tool_id);
        tags.push("agent-gated".to_owned());
        return Some(tags);
    }
    // Layer B: global mode.
    match mode {
        ApprovalMode::Off => None,
        ApprovalMode::Manual => {
            let mut tags = classify_risk(tool_id);
            tags.push("manual-mode".to_owned());
            Some(tags)
        }
        ApprovalMode::Smart => {
            let tags = classify_risk(tool_id);
            if tags.is_empty() {
                None
            } else {
                Some(tags)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parses_case_insensitively_and_defaults_off() {
        assert_eq!(ApprovalMode::from_pref("MANUAL"), ApprovalMode::Manual);
        assert_eq!(ApprovalMode::from_pref(" smart "), ApprovalMode::Smart);
        assert_eq!(ApprovalMode::from_pref(""), ApprovalMode::Off);
        assert_eq!(ApprovalMode::from_pref("bogus"), ApprovalMode::Off);
    }

    #[test]
    fn classify_uses_action_segment() {
        assert!(!classify_risk("gmail__send_email").is_empty());
        assert!(!classify_risk("fs__delete_file").is_empty());
        // Broad read verbs are not risky.
        assert!(classify_risk("web_fetch__get").is_empty());
        assert!(classify_risk("shadow__semantic_search").is_empty());
        // The server prefix must not leak a match (only the action segment counts).
        assert!(classify_risk("sender__list_items").is_empty());
    }

    #[test]
    fn off_mode_gates_nothing_without_agent_layer() {
        assert!(
            should_require_approval_local(&[], "gmail__send_email", ApprovalMode::Off).is_none()
        );
    }

    #[test]
    fn manual_mode_gates_everything() {
        assert!(
            should_require_approval_local(&[], "web_fetch__get", ApprovalMode::Manual).is_some()
        );
    }

    #[test]
    fn smart_mode_gates_only_risky() {
        assert!(
            should_require_approval_local(&[], "gmail__send_email", ApprovalMode::Smart).is_some()
        );
        assert!(
            should_require_approval_local(&[], "web_fetch__get", ApprovalMode::Smart).is_none()
        );
    }

    #[test]
    fn agent_layer_gates_regardless_of_mode() {
        let agent = vec!["custom__thing".to_owned()];
        let tags = should_require_approval_local(&agent, "custom__thing", ApprovalMode::Off)
            .expect("agent-gated tool must require approval even in Off mode");
        assert!(tags.iter().any(|t| t == "agent-gated"));
    }
}
