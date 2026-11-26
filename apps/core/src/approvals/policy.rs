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
//!       - `off`    → Layer B never gates (Layers A/B′ may still).
//!       - `manual` → every tool call is gated.
//!       - `smart`  → only tool calls classified *risky* are gated. This is the
//!         DEFAULT: an unset/unrecognized pref resolves to `smart`, so risky
//!         irreversible tools (send/delete/pay/deploy) get HITL on a default
//!         install. `off` must be an explicit operator choice.
//!
//!   - **Layer C — organization policy consult.** On an org-bound node the
//!     control plane's effective tool policy (`deniedTools` / `allowedTools`,
//!     refreshed live by `sidecar::control_plane::run_scope_refresh_loop`) is
//!     consulted *before* Layers A/B. A tool the organization denies, or one
//!     outside a non-empty org allowlist, is refused outright: it is never
//!     queued, because a local approval must not be able to override an
//!     administrator's decision. Layer C never *adds* a gate for a tool the
//!     policy allows, and it is a no-op on unbound nodes. The policy has no
//!     "require approval" rule today, so this conservative deny-only form is the
//!     whole layer; MCP-server allowlists are enforced at dispatch, where the
//!     serving server is known.
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
    /// Layer B gates nothing. Requires an EXPLICIT `off` pref; Layers A/B′ may
    /// still gate.
    Off,
    /// Layer B gates only tool calls classified risky (see [`classify_risk`]).
    /// The default for an unset/unrecognized pref.
    Smart,
    /// Layer B gates every tool call.
    Manual,
}

impl ApprovalMode {
    /// Parse the pref string. Only an explicit `off` disables Layer B; anything
    /// unrecognized (incl. empty/absent) resolves to the fail-safe `Smart`
    /// default so risky tools are gated out of the box.
    pub fn from_pref(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "manual" => ApprovalMode::Manual,
            "off" => ApprovalMode::Off,
            _ => ApprovalMode::Smart,
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
    // Exec / mutating / transfer verb classes (security M11). Matching is
    // substring-based, so "exec" also covers "execute" and "write" also covers
    // "overwrite"/"rewrite". `read` stays deliberately absent (too noisy).
    "run",
    "exec",
    "write",
    "download",
    "upload",
    "fetch",
    // Worktree verbs: `apply` merges an agent-authored worktree into the user's
    // base branch, `open_pr` publishes it, `discard` irreversibly deletes work.
    "apply",
    "discard",
    "open_pr",
    // Workflow minting: workflows dispatch tools through the ungated engine
    // plane, so an agent creating/reconfiguring one is a laundering path around
    // HITL — gate the minting itself.
    "create_workflow",
    "configure_workflow",
];

/// Governance-mutating actions (exact two-segment suffix match): tools that let an
/// agent alter its own damage-limiting controls (e.g. raise or remove the
/// Gateway spend cap via `ryu.gateway.budget.set`). Like the CoreApi-mutation
/// rule, these gate whenever the operator has not EXPLICITLY opted out with
/// `approval-mode=off` — the verb heuristic alone would miss them.
const GOVERNANCE_ACTIONS: &[&str] = &["budget.set"];

/// Spaces mutations change user-owned knowledge or the calling agent's access
/// scope, so they must be explicitly approved unless the operator selected the
/// global `off` mode. Reads remain outside this list.
const SPACE_MUTATION_ACTIONS: &[&str] = &[
    "attach_space",
    "create_file",
    "create_page",
    "create_space",
    "detach_space",
    "rename_space",
];

/// An agent's hosted email address is a public identity: claiming one is
/// permanent (addresses are never reissued), and sending or replying speaks for
/// the organization to outside recipients. Gate all four unless the operator
/// selected the global `off` mode (exact `<namespace>.<action>` match).
/// `set_address` is refused locally without a service call, so it is not here.
const AGENT_INBOX_MUTATION_ACTIONS: &[&str] = &[
    "agent_inbox.claim_email_alias",
    "agent_inbox.create",
    "agent_inbox.send",
    "agent_inbox.reply",
];

/// `agent_inbox` tools that only read the calling agent's own alias and mail.
/// Their names contain `email` or `message`, which the smart name heuristic
/// treats as outbound verbs; reading one's own inbox is not, so smart mode lets
/// them through. Manual mode still gates them like every other tool.
const AGENT_INBOX_READ_ACTIONS: &[&str] = &[
    "agent_inbox.get",
    "agent_inbox.check_email_alias",
    "agent_inbox.check_address",
    "agent_inbox.list_messages",
    "agent_inbox.read_message",
    "agent_inbox.get_verification_code",
];

/// Workspace shell actions that change how Ryu looks for the user rather than
/// only taking them somewhere. Opening a page stays ungated; switching the whole
/// interface always asks the user, even under the global `off` mode.
const WORKSPACE_SHELL_MUTATION_ACTIONS: &[&str] = &["workspace.switch_interface"];

/// Routine CRUD changes what runs in the background, so it is a consequential
/// mutation even when the action name is not one of the broad outbound verbs.
const ROUTINE_MUTATION_ACTIONS: &[&str] = &["create", "update", "delete", "run_now"];

/// The dashboard builder's write tools (exact `<namespace>.<action>` match). A
/// widget they add is refreshed on a timer with nobody approving each run, so
/// creating or changing a dashboard is background execution like a routine and
/// is gated the same way. `get_dashboard` only reads and stays ungated.
const DASHBOARD_MUTATION_ACTIONS: &[&str] = &[
    "dashboard_builder.create_dashboard",
    "dashboard_builder.configure_dashboard",
];

/// The action segment of a tool id: the part after the last namespace separator
/// (`<server>.<tool>` → `<tool>`), lowercased. Legacy ids are normalized at the
/// Core tool ingress before this policy reads them. Falls back to the whole id.
fn action_segment(tool_id: &str) -> String {
    crate::sidecar::mcp::canonical_tool_id(tool_id)
        .rsplit('.')
        .next()
        .unwrap_or(tool_id)
        .to_ascii_lowercase()
}

/// The final namespace plus action (`budget.set` for
/// `ryu.gateway.budget.set`). Governance rules use this narrower shape so a
/// generic `set` tool cannot accidentally inherit governance semantics.
fn action_suffix(tool_id: &str) -> String {
    let canonical = crate::sidecar::mcp::canonical_tool_id(tool_id);
    let mut segments = canonical.rsplit('.');
    let action = segments.next().unwrap_or(&canonical);
    let Some(namespace) = segments.next() else {
        return action.to_ascii_lowercase();
    };
    format!("{namespace}.{action}").to_ascii_lowercase()
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

/// Layer **C** (pure): the organization tool policy verdict for `tool_id`.
/// Returns the denial reason when the policy refuses the call, `None` when there
/// is no policy or it allows the call.
pub fn org_policy_denial(
    rules: Option<&crate::org_policy::OrgToolRules>,
    tool_id: &str,
) -> Option<String> {
    let rules = rules?;
    match crate::org_policy::evaluate_tool(
        rules,
        &crate::sidecar::mcp::canonical_tool_id(tool_id),
        None,
    ) {
        crate::org_policy::ToolPolicyDecision::Allow => None,
        crate::org_policy::ToolPolicyDecision::Deny { reason } => Some(reason),
    }
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
    if crate::runnable::agent_configuration_policy::requires_operator_approval(
        &crate::sidecar::mcp::canonical_tool_id(tool_id),
    ) {
        return Some(vec!["agent-configuration".to_owned()]);
    }
    // Research executes agent-edited native code outside Core's JS/WASI
    // sandbox. It is therefore a privileged unsandboxed capability: every
    // attempt needs an operator decision, including when the global approval
    // preference is explicitly `off`.
    if tool_id == "research.run" {
        return Some(vec!["privileged-native-execution".to_owned()]);
    }
    // A Ryu Challenges submission publishes a project entry under the user's
    // own account and identity. Like research.run it is confirmed on every call,
    // including under an explicit `off`: the agent may draft it, but only the
    // user decides that it is sent.
    if crate::sidecar::mcp::canonical_tool_id(tool_id)
        == crate::sidecar::mcp::challenges_tool::SUBMIT_TOOL_ID
    {
        let mut tags = classify_risk(tool_id);
        tags.push("challenge-submission".to_owned());
        return Some(tags);
    }
    // Layer A: this agent explicitly gates this tool.
    if agent_approval_tools.iter().any(|t| t == tool_id) {
        let mut tags = classify_risk(tool_id);
        tags.push("agent-gated".to_owned());
        return Some(tags);
    }
    // Layer B′ — Core self-API mutations and the interface switch. A mutating
    // (non-GET) `ryu_api.*` tool lets an agent drive Ryu itself (Gateway
    // routing, budgets, guardrails, model launch settings, installed packages),
    // and switching the interface changes what the user is looking at. Both
    // need the person's explicit approval on every call, like `research.run`:
    // in a live chat that is the in-chat card (`chat_grants`), elsewhere the
    // Approvals inbox. An explicit `off` does NOT skip it; `off` is for the
    // agent's ordinary tools, not for letting it reconfigure Ryu unasked. The
    // multi-tenant boundary is separate: on an org-bound node `self_api`
    // dispatch checks the person's role before the loopback runs.
    let core_api_opted_out = matches!(
        mode_pref.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("off")
    );
    if crate::self_api::is_mutating(tool_id) {
        let mut tags = classify_risk(tool_id);
        tags.push("core-api-mutation".to_owned());
        return Some(tags);
    }
    if WORKSPACE_SHELL_MUTATION_ACTIONS.contains(&action_suffix(tool_id).as_str()) {
        let mut tags = classify_risk(tool_id);
        tags.push("workspace-shell-mutation".to_owned());
        return Some(tags);
    }
    // Layer B′ (continued) — DERIVED app-API mutations. A derived tool
    // (`ryu_ext.…`, generated from an app sidecar's OpenAPI document) reaches an
    // endpoint nobody hand-picked: a single installed app can contribute hundreds
    // of them, so a non-GET one is the same "the model is writing to real state"
    // shape as the CoreApi rule, over a far wider surface.
    //
    // It needs its own arm because neither existing layer covers it.
    // `self_api::is_mutating` keys on the `ryu_api.` prefix and returns false
    // for these, and `RISKY_PATTERNS` carries no `put`/`patch` entry — so a
    // derived PUT or PATCH was gated by *nothing*, on a node whose operator had
    // explicitly chosen `approval-mode=smart`. (`post` and `delete` do happen to
    // hit the verb heuristic, but that is coincidence, not coverage: the
    // heuristic is matching the English word, not the HTTP method, so it would
    // also miss them under a different id spelling and it tags them as something
    // other than a mutation.)
    //
    // The grammar has exactly ONE definition, [`crate::ext_api::is_mutating`],
    // which reads the method from a fixed position (the first token after the last
    // `.`) rather than scanning for a verb word anywhere in the id. That is not a
    // refactor of the same rule: a scan classifies `…__get_blog_post` as a WRITE
    // because the slug contains `post`, and gating plain reads is how operators
    // learn to click through prompts — which is how the real writes stop being
    // read either.
    //
    // Unlike the CoreApi rule, an app's own API keeps the `off` escape hatch:
    // these write the app's data (a note, a contact), not Ryu's configuration.
    // Gate on unset / `smart` / `manual`, and let ONLY an explicit `off` through.
    if !core_api_opted_out && crate::ext_api::is_mutating(tool_id) {
        let mut tags = classify_risk(tool_id);
        tags.push("ext-api-mutation".to_owned());
        return Some(tags);
    }
    // Layer B′ (continued) — governance mutations. Same escape-hatch semantics
    // as the CoreApi rule: an agent must never silently loosen its own
    // damage-limiting controls unless the operator explicitly opted out.
    if !core_api_opted_out && GOVERNANCE_ACTIONS.contains(&action_suffix(tool_id).as_str()) {
        let mut tags = classify_risk(tool_id);
        tags.push("governance-mutation".to_owned());
        return Some(tags);
    }
    if !core_api_opted_out
        && action_suffix(tool_id)
            .strip_prefix("routines.")
            .is_some_and(|action| ROUTINE_MUTATION_ACTIONS.contains(&action))
    {
        let mut tags = classify_risk(tool_id);
        tags.push("routine-mutation".to_owned());
        return Some(tags);
    }
    if !core_api_opted_out && DASHBOARD_MUTATION_ACTIONS.contains(&action_suffix(tool_id).as_str())
    {
        let mut tags = classify_risk(tool_id);
        tags.push("dashboard-mutation".to_owned());
        return Some(tags);
    }
    if !core_api_opted_out
        && AGENT_INBOX_MUTATION_ACTIONS.contains(&action_suffix(tool_id).as_str())
    {
        let mut tags = classify_risk(tool_id);
        tags.push("agent-inbox-mutation".to_owned());
        return Some(tags);
    }
    if !core_api_opted_out && SPACE_MUTATION_ACTIONS.contains(&action_segment(tool_id).as_str()) {
        let mut tags = classify_risk(tool_id);
        tags.push("spaces-mutation".to_owned());
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
            if AGENT_INBOX_READ_ACTIONS.contains(&action_suffix(tool_id).as_str()) {
                return None;
            }
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
mod dashboard_tests;
#[cfg(test)]
mod tests;
