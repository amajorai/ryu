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
mod tests {
    use super::*;

    #[test]
    fn org_policy_layer_denies_only_what_the_policy_refuses() {
        let rules = crate::org_policy::OrgToolRules {
            allowed_tools: vec!["github.*".to_owned(), "plans.*".to_owned()],
            denied_tools: vec!["github.delete_*".to_owned()],
            allowed_mcp_servers: Vec::new(),
        };
        assert!(org_policy_denial(None, "github.delete_repo").is_none());
        assert!(org_policy_denial(Some(&rules), "github.get_repo").is_none());
        assert!(org_policy_denial(Some(&rules), "github.delete_repo")
            .is_some_and(|reason| reason.contains("denied")));
        assert!(org_policy_denial(Some(&rules), "slack.post_message")
            .is_some_and(|reason| reason.contains("not in your organization's allowed tools")));
    }

    #[test]
    fn mode_parses_case_insensitively_and_defaults_smart() {
        assert_eq!(ApprovalMode::from_pref("MANUAL"), ApprovalMode::Manual);
        assert_eq!(ApprovalMode::from_pref(" smart "), ApprovalMode::Smart);
        assert_eq!(ApprovalMode::from_pref(" OFF "), ApprovalMode::Off);
        // Unset/empty/unrecognized resolve to the fail-safe Smart default —
        // only an explicit `off` disables Layer B.
        assert_eq!(ApprovalMode::from_pref(""), ApprovalMode::Smart);
        assert_eq!(ApprovalMode::from_pref("bogus"), ApprovalMode::Smart);
    }

    #[test]
    fn governance_mutation_gates_unless_explicit_off() {
        // `budget.set` lets the agent raise/remove its own spend cap; the verb
        // heuristic misses it, so the governance rule must gate it — including
        // under the unset default — with only explicit `off` opting out.
        let t = "ryu.gateway.budget.set";
        let tags = should_require_approval_local(&[], t, ApprovalMode::Smart, None)
            .expect("governance mutation must gate under the default");
        assert!(tags.iter().any(|t| t == "governance-mutation"));
        assert!(
            should_require_approval_local(&[], t, ApprovalMode::Manual, Some("manual")).is_some()
        );
        assert!(should_require_approval_local(&[], t, ApprovalMode::Off, Some("off")).is_none());
    }

    #[test]
    fn agent_inbox_mutations_gate_unless_explicit_off_and_reads_do_not() {
        for tool in [
            "agent_inbox.claim_email_alias",
            "agent_inbox.create",
            "agent_inbox.send",
            "agent_inbox.reply",
        ] {
            let tags = should_require_approval_local(&[], tool, ApprovalMode::Smart, Some("smart"))
                .expect("an address claim or a send must gate under smart");
            assert!(tags.iter().any(|t| t == "agent-inbox-mutation"), "{tool}");
            assert!(should_require_approval_local(&[], tool, ApprovalMode::Smart, None).is_some());
            assert!(
                should_require_approval_local(&[], tool, ApprovalMode::Off, Some("off")).is_none(),
                "{tool}"
            );
        }
        for tool in [
            "agent_inbox.get",
            "agent_inbox.check_email_alias",
            "agent_inbox.check_address",
            "agent_inbox.list_messages",
            "agent_inbox.read_message",
            "agent_inbox.get_verification_code",
            "agent_inbox.set_address",
        ] {
            assert!(
                should_require_approval_local(&[], tool, ApprovalMode::Smart, Some("smart"))
                    .is_none(),
                "{tool}"
            );
            assert!(
                should_require_approval_local(&[], tool, ApprovalMode::Manual, Some("manual"))
                    .is_some(),
                "manual mode still gates {tool}"
            );
        }
    }

    #[test]
    fn challenge_submission_always_requires_user_confirmation() {
        for (mode, pref) in [
            (ApprovalMode::Smart, None),
            (ApprovalMode::Smart, Some("smart")),
            (ApprovalMode::Manual, Some("manual")),
            (ApprovalMode::Off, Some("off")),
        ] {
            let tags = should_require_approval_local(&[], "challenges.submit", mode, pref)
                .expect("challenges.submit must always be confirmed");
            assert!(tags.iter().any(|tag| tag == "challenge-submission"));
        }
        for read in ["challenges.list", "challenges.get"] {
            assert!(
                should_require_approval_local(&[], read, ApprovalMode::Smart, Some("smart"))
                    .is_none(),
                "{read}"
            );
        }
    }

    #[test]
    fn routine_mutations_gate_unless_explicit_off() {
        for action in ["create", "update", "delete", "run_now"] {
            let tool = format!("routines.{action}");
            let tags =
                should_require_approval_local(&[], &tool, ApprovalMode::Smart, Some("smart"))
                    .expect("routine mutations must gate under smart mode");
            assert!(tags.iter().any(|tag| tag == "routine-mutation"), "{tool}");
            assert!(
                should_require_approval_local(&[], &tool, ApprovalMode::Off, Some("off")).is_none()
            );
        }
        assert!(should_require_approval_local(
            &[],
            "routines.list",
            ApprovalMode::Smart,
            Some("smart")
        )
        .is_none());
        // Unset/empty mode is not an explicit opt-out.
        assert!(
            should_require_approval_local(&[], "routines.create", ApprovalMode::Off, None)
                .is_some()
        );
    }

    #[test]
    fn interface_switch_always_gates_and_page_opens_do_not() {
        let tags = should_require_approval_local(
            &[],
            "workspace.switch_interface",
            ApprovalMode::Smart,
            Some("smart"),
        )
        .expect("switching the interface must ask the user");
        assert!(tags.iter().any(|tag| tag == "workspace-shell-mutation"));
        assert!(should_require_approval_local(
            &[],
            "workspace.switch_interface",
            ApprovalMode::Off,
            None
        )
        .is_some());
        assert!(should_require_approval_local(
            &[],
            "workspace.switch_interface",
            ApprovalMode::Off,
            Some("off")
        )
        .is_some());
        assert!(should_require_approval_local(
            &[],
            "workspace.open_tab",
            ApprovalMode::Smart,
            Some("smart")
        )
        .is_none());
    }

    /// The headline gate: a derived non-GET tool must gate under `smart`.
    ///
    /// The ids here are chosen so the test cannot pass for the wrong reason. `put`
    /// and `patch` are absent from `RISKY_PATTERNS` and the ids are not
    /// `ryu_api.*`, so *nothing else in this module* gates them — asserted
    /// explicitly, because a POST/DELETE id would have been caught by the verb
    /// heuristic and this test would have been green with the new arm deleted.
    #[test]
    fn non_get_derived_tool_requires_approval_under_smart() {
        let put = "ryu_ext.ryu_crm.put_contacts_id";
        assert!(
            classify_risk(put).is_empty(),
            "the verb heuristic must NOT be what gates this, or the derived rule is untested"
        );
        assert!(
            !crate::self_api::is_mutating(put),
            "the CoreApi rule must NOT be what gates this either"
        );
        let tags = should_require_approval_local(&[], put, ApprovalMode::Smart, Some("smart"))
            .expect("a derived PUT must gate under smart");
        assert!(tags.iter().any(|t| t == "ext-api-mutation"));

        // PATCH is the other verb the heuristic misses entirely.
        let patch = "ryu_ext.ryu_crm.patch_contacts_id";
        assert!(classify_risk(patch).is_empty());
        let tags = should_require_approval_local(&[], patch, ApprovalMode::Smart, Some("smart"))
            .expect("a derived PATCH must gate under smart");
        assert!(tags.iter().any(|t| t == "ext-api-mutation"));

        // POST/DELETE gate through the same arm (and so carry the same tag), even
        // though the verb heuristic would also have flagged them.
        for id in [
            "ryu_ext.ryu_crm.post_contacts",
            "ryu_ext.ryu_crm.delete_contacts_id",
        ] {
            let tags = should_require_approval_local(&[], id, ApprovalMode::Smart, Some("smart"))
                .expect("a derived write must gate under smart");
            assert!(tags.iter().any(|t| t == "ext-api-mutation"), "{id}");
        }

        // The id grammar puts the method at a FIXED position (the first token after
        // the last namespace separator), so a slug that merely contains a verb word no longer
        // over-gates: `get_blog_post` is a read. That precision is the point — an
        // earlier draft scanned every token, which read `post` out of the slug and
        // gated plain reads, and an operator who is prompted on reads stops reading
        // the prompts that guard the writes.
        assert!(!crate::ext_api::is_mutating(
            "ryu_ext.ryu_news.get_blog_post"
        ));
    }

    /// The read path stays free. Derived GETs are the bulk of any OpenAPI surface,
    /// and gating them would train operators to click through prompts — which is
    /// how the writes above stop being read either.
    #[test]
    fn get_derived_tool_does_not_require_approval() {
        let get = "ryu_ext.ryu_crm.get_contacts";
        assert!(
            should_require_approval_local(&[], get, ApprovalMode::Smart, Some("smart")).is_none()
        );
        assert!(should_require_approval_local(&[], get, ApprovalMode::Off, None).is_none());
        // `manual` still gates everything; the derived rule grants no exemption.
        assert!(
            should_require_approval_local(&[], get, ApprovalMode::Manual, Some("manual")).is_some()
        );
        // An id that is not on the derived plane is not this rule's business, even
        // when its action segment looks identical.
        assert!(!crate::ext_api::is_mutating("crm.put_contacts_id"));
        // An id that carries the derived PREFIX but not the grammar has no method
        // token to read, so it gates. That is the deliberate fail-safe direction:
        // an unparseable derived id costs one extra prompt, whereas guessing "read"
        // on a shape we do not understand is the expensive way to be wrong.
        assert!(crate::ext_api::is_mutating("ryu_ext.crm_contacts"));
    }

    /// The `off` escape hatch for app APIs: the operator has to say `off` out
    /// loud. Unset and empty are "never chose", not "chose off".
    #[test]
    fn derived_mutation_gate_is_disabled_only_by_explicit_off() {
        let put = "ryu_ext.ryu_crm.put_contacts_id";
        assert!(should_require_approval_local(&[], put, ApprovalMode::Off, None).is_some());
        assert!(should_require_approval_local(&[], put, ApprovalMode::Off, Some("")).is_some());
        assert!(
            should_require_approval_local(&[], put, ApprovalMode::Smart, Some("smart")).is_some()
        );
        assert!(
            should_require_approval_local(&[], put, ApprovalMode::Manual, Some("manual")).is_some()
        );
        // The ONE opt-out, tolerant of case/whitespace like the CoreApi rule.
        assert!(should_require_approval_local(&[], put, ApprovalMode::Off, Some("off")).is_none());
        assert!(
            should_require_approval_local(&[], put, ApprovalMode::Off, Some(" OFF ")).is_none()
        );
    }

    #[test]
    fn classify_flags_worktree_and_workflow_minting_verbs() {
        assert!(!classify_risk("ryu.worktree.apply").is_empty());
        assert!(!classify_risk("ryu.worktree.discard").is_empty());
        assert!(!classify_risk("ryu.worktree.open_pr").is_empty());
        assert!(!classify_risk("workflow_builder.create_workflow").is_empty());
        assert!(!classify_risk("workflow_builder.configure_workflow").is_empty());
        // Reads on the same servers stay free.
        assert!(classify_risk("workflow_builder.get_workflow").is_empty());
    }

    #[test]
    fn classify_uses_action_segment() {
        assert!(!classify_risk("gmail.send_email").is_empty());
        assert!(!classify_risk("fs.delete_file").is_empty());
        // Broad read verbs are not risky.
        assert!(classify_risk("web_fetch.get").is_empty());
        assert!(classify_risk("shadow.semantic_search").is_empty());
        // The server prefix must not leak a match (only the action segment counts).
        assert!(classify_risk("sender.list_items").is_empty());
    }

    #[test]
    fn classify_flags_exec_and_mutating_verbs() {
        // `rtk` executes arbitrary dev commands — it must classify risky so Smart
        // mode gates it (security M6/M11). As a declarative `command` plugin tool
        // its callable id is now `app.rtk.run`, but `classify_risk` keys on the
        // action segment after the last namespace separator, so the `run` verb still classifies.
        assert!(classify_risk("app.rtk.run").iter().any(|t| t == "run"));
        // Exec / write / transfer verb classes.
        assert!(!classify_risk("shell.exec").is_empty());
        assert!(!classify_risk("db.execute_query").is_empty());
        assert!(!classify_risk("fs.write_file").is_empty());
        assert!(!classify_risk("fs.overwrite").is_empty());
        assert!(!classify_risk("s3.upload_object").is_empty());
        assert!(!classify_risk("model.download").is_empty());
        assert!(!classify_risk("web.fetch").is_empty());
        // `read` is deliberately not risky.
        assert!(classify_risk("fs.read_file").is_empty());
    }

    #[test]
    fn smart_mode_gates_rtk_run_and_write_tools() {
        assert!(should_require_approval_local(
            &[],
            "app.rtk.run",
            ApprovalMode::Smart,
            Some("smart")
        )
        .is_some());
        assert!(should_require_approval_local(
            &[],
            "fs.write_file",
            ApprovalMode::Smart,
            Some("smart")
        )
        .is_some());
    }

    #[test]
    fn research_runs_require_operator_approval_even_when_global_mode_is_off() {
        for (mode, preference) in [
            (ApprovalMode::Off, Some("off")),
            (ApprovalMode::Smart, Some("smart")),
            (ApprovalMode::Manual, Some("manual")),
        ] {
            let tags = should_require_approval_local(&[], "research.run", mode, preference)
                .expect("native research execution must always require approval");
            assert!(tags.iter().any(|tag| tag == "privileged-native-execution"));
        }
    }

    #[test]
    fn agent_configuration_requires_approval_in_every_mode_and_legacy_namespace() {
        for tool in [
            "agent_builder.configure_agent",
            "agent_builder__configure_agent",
        ] {
            for (mode, preference) in [
                (ApprovalMode::Off, Some("off")),
                (ApprovalMode::Smart, Some("smart")),
                (ApprovalMode::Manual, Some("manual")),
                (ApprovalMode::Smart, None),
            ] {
                let tags = should_require_approval_local(&[], tool, mode, preference)
                    .expect("agent configuration always requires operator review");
                assert!(tags.iter().any(|tag| tag == "agent-configuration"));
            }
        }
    }

    #[test]
    fn off_mode_gates_nothing_without_agent_layer() {
        assert!(should_require_approval_local(
            &[],
            "gmail.send_email",
            ApprovalMode::Off,
            Some("off")
        )
        .is_none());
    }

    #[test]
    fn manual_mode_gates_everything() {
        assert!(should_require_approval_local(
            &[],
            "web_fetch.get",
            ApprovalMode::Manual,
            Some("manual")
        )
        .is_some());
    }

    #[test]
    fn smart_mode_gates_only_risky() {
        assert!(should_require_approval_local(
            &[],
            "gmail.send_email",
            ApprovalMode::Smart,
            Some("smart")
        )
        .is_some());
        assert!(should_require_approval_local(
            &[],
            "web_fetch.get",
            ApprovalMode::Smart,
            Some("smart")
        )
        .is_none());
    }

    #[test]
    fn core_api_mutation_gates_in_every_mode_including_explicit_off() {
        // A PUT self-API tool: the verb heuristic would NOT catch it, but the
        // CoreApi-mutation rule must, in every mode.
        let put = "ryu_api.put_api_gateway_config";
        for (mode, pref) in [
            (ApprovalMode::Smart, Some("smart")),
            (ApprovalMode::Manual, Some("manual")),
            (ApprovalMode::Off, Some("off")),
            (ApprovalMode::Off, None),
        ] {
            let tags = should_require_approval_local(&[], put, mode, pref)
                .expect("changing Ryu itself always needs the person's approval");
            // The tag is present so the approval card can explain why.
            assert!(tags.iter().any(|t| t == "core-api-mutation"), "{pref:?}");
        }
        // Reads stay ungated, so looking around never prompts.
        assert!(should_require_approval_local(
            &[],
            "ryu_api.get_api_gateway_config",
            ApprovalMode::Off,
            Some("off")
        )
        .is_none());
    }

    #[test]
    fn core_api_mutation_gates_under_unset_default() {
        // The user mandate: mutations need HITL even under the default (unset)
        // approval mode. Unset pref (`None`) collapses to `ApprovalMode::Off`, but
        // the CoreApi rule still gates it — only an *explicit* `off` opts out.
        let put = "ryu_api.put_api_agents_id";
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
            should_require_approval_local(&[], "web_fetch.get", ApprovalMode::Off, None).is_none()
        );
        assert!(
            should_require_approval_local(&[], "gmail.send_email", ApprovalMode::Off, None)
                .is_none()
        );
    }

    #[test]
    fn core_api_get_flows_free() {
        // A GET self-API tool is a read: never gated by the CoreApi rule (smart
        // leaves it free; only the ordinary Layer-B `manual` blanket-gates it).
        let get = "ryu_api.get_api_quests";
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
        let agent = vec!["custom.thing".to_owned()];
        let tags =
            should_require_approval_local(&agent, "custom.thing", ApprovalMode::Off, Some("off"))
                .expect("agent-gated tool must require approval even in Off mode");
        assert!(tags.iter().any(|t| t == "agent-gated"));
    }
}
