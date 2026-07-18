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
    mode_pref: Option<&str>,
) -> Option<Vec<String>> {
    // Layer A: this agent explicitly gates this tool.
    if agent_approval_tools.iter().any(|t| t == tool_id) {
        let mut tags = classify_risk(tool_id);
        tags.push("agent-gated".to_owned());
        return Some(tags);
    }
    // Layer B′ — Core self-API mutations. A mutating (non-GET) `ryu_api__*` tool
    // lets an agent drive Ryu itself (create/delete/update Core state), so it is
    // treated as risky *regardless* of whether the verb heuristic fires — closing
    // the gap where `put`/`patch` slip past `RISKY_PATTERNS`.
    //
    // Unlike ordinary Layer B, this gate reads the *raw* pref (`mode_pref`) rather
    // than the collapsed [`ApprovalMode`], so it can tell an unset pref from an
    // explicit `off`. Per the user mandate that mutations need a human in the loop,
    // it gates whenever the operator has NOT explicitly opted out — i.e. on unset
    // (`None`), `smart`, and `manual`. The ONE escape hatch is an explicit `off`,
    // where an operator says "let the agent run unattended". The multi-tenant
    // safety boundary is still the org-bound *refusal* in `self_api` dispatch (a
    // shared node rejects CoreApi entirely); this gate is the unbound-node HITL.
    let core_api_opted_out = matches!(
        mode_pref.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("off")
    );
    if !core_api_opted_out && crate::self_api::is_mutating(tool_id) {
        let mut tags = classify_risk(tool_id);
        tags.push("core-api-mutation".to_owned());
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
        assert!(should_require_approval_local(
            &[],
            "gmail__send_email",
            ApprovalMode::Off,
            Some("off")
        )
        .is_none());
    }

    #[test]
    fn manual_mode_gates_everything() {
        assert!(should_require_approval_local(
            &[],
            "web_fetch__get",
            ApprovalMode::Manual,
            Some("manual")
        )
        .is_some());
    }

    #[test]
    fn smart_mode_gates_only_risky() {
        assert!(should_require_approval_local(
            &[],
            "gmail__send_email",
            ApprovalMode::Smart,
            Some("smart")
        )
        .is_some());
        assert!(should_require_approval_local(
            &[],
            "web_fetch__get",
            ApprovalMode::Smart,
            Some("smart")
        )
        .is_none());
    }

    #[test]
    fn core_api_mutation_gates_in_smart_and_manual_but_not_explicit_off() {
        // A PUT self-API tool: the verb heuristic would NOT catch it, but the
        // CoreApi-mutation rule must — in both smart and manual.
        let put = "ryu_api__put_api_agents_id";
        assert!(
            should_require_approval_local(&[], put, ApprovalMode::Smart, Some("smart")).is_some()
        );
        assert!(
            should_require_approval_local(&[], put, ApprovalMode::Manual, Some("manual")).is_some()
        );
        // An explicit `off` is the ONE escape hatch.
        assert!(should_require_approval_local(&[], put, ApprovalMode::Off, Some("off")).is_none());
        // The tag is present so the approval card can explain why.
        let tags = should_require_approval_local(&[], put, ApprovalMode::Smart, Some("smart"))
            .expect("gated in smart");
        assert!(tags.iter().any(|t| t == "core-api-mutation"));
    }

    #[test]
    fn core_api_mutation_gates_under_unset_default() {
        // The user mandate: mutations need HITL even under the default (unset)
        // approval mode. Unset pref (`None`) collapses to `ApprovalMode::Off`, but
        // the CoreApi rule still gates it — only an *explicit* `off` opts out.
        let put = "ryu_api__put_api_agents_id";
        let tags = should_require_approval_local(&[], put, ApprovalMode::Off, None)
            .expect("CoreApi mutation must gate under the unset default");
        assert!(tags.iter().any(|t| t == "core-api-mutation"));
        // An empty stored value is treated the same as unset (still gates).
        assert!(should_require_approval_local(&[], put, ApprovalMode::Off, Some("")).is_some());
    }

    #[test]
    fn non_core_api_tool_unchanged_under_unset() {
        // Ordinary (non-CoreApi) tools are NOT gated under the unset default —
        // only the CoreApi-mutation rule fires on unset; Layer B stays `Off`.
        assert!(
            should_require_approval_local(&[], "web_fetch__get", ApprovalMode::Off, None).is_none()
        );
        assert!(
            should_require_approval_local(&[], "gmail__send_email", ApprovalMode::Off, None)
                .is_none()
        );
    }

    #[test]
    fn core_api_get_flows_free() {
        // A GET self-API tool is a read: never gated by the CoreApi rule (smart
        // leaves it free; only the ordinary Layer-B `manual` blanket-gates it).
        let get = "ryu_api__get_api_quests";
        assert!(
            should_require_approval_local(&[], get, ApprovalMode::Smart, Some("smart")).is_none()
        );
        assert!(should_require_approval_local(&[], get, ApprovalMode::Off, None).is_none());
        // Manual still gates everything, including reads — that's Layer B, not B′.
        assert!(
            should_require_approval_local(&[], get, ApprovalMode::Manual, Some("manual")).is_some()
        );
    }

    #[test]
    fn agent_layer_gates_regardless_of_mode() {
        let agent = vec!["custom__thing".to_owned()];
        let tags =
            should_require_approval_local(&agent, "custom__thing", ApprovalMode::Off, Some("off"))
                .expect("agent-gated tool must require approval even in Off mode");
        assert!(tags.iter().any(|t| t == "agent-gated"));
    }
}
