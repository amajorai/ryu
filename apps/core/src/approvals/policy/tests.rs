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
    assert!(should_require_approval_local(&[], t, ApprovalMode::Manual, Some("manual")).is_some());
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
            should_require_approval_local(&[], tool, ApprovalMode::Smart, Some("smart")).is_none(),
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
            should_require_approval_local(&[], read, ApprovalMode::Smart, Some("smart")).is_none(),
            "{read}"
        );
    }
}

#[test]
fn routine_mutations_gate_unless_explicit_off() {
    for action in ["create", "update", "delete", "run_now"] {
        let tool = format!("routines.{action}");
        let tags = should_require_approval_local(&[], &tool, ApprovalMode::Smart, Some("smart"))
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
        should_require_approval_local(&[], "routines.create", ApprovalMode::Off, None).is_some()
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
    assert!(should_require_approval_local(&[], get, ApprovalMode::Smart, Some("smart")).is_none());
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
    assert!(should_require_approval_local(&[], put, ApprovalMode::Smart, Some("smart")).is_some());
    assert!(
        should_require_approval_local(&[], put, ApprovalMode::Manual, Some("manual")).is_some()
    );
    // The ONE opt-out, tolerant of case/whitespace like the CoreApi rule.
    assert!(should_require_approval_local(&[], put, ApprovalMode::Off, Some("off")).is_none());
    assert!(should_require_approval_local(&[], put, ApprovalMode::Off, Some(" OFF ")).is_none());
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
    assert!(
        should_require_approval_local(&[], "app.rtk.run", ApprovalMode::Smart, Some("smart"))
            .is_some()
    );
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
    assert!(
        should_require_approval_local(&[], "gmail.send_email", ApprovalMode::Off, Some("off"))
            .is_none()
    );
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
    assert!(should_require_approval_local(&[], "web_fetch.get", ApprovalMode::Off, None).is_none());
    assert!(
        should_require_approval_local(&[], "gmail.send_email", ApprovalMode::Off, None).is_none()
    );
}

#[test]
fn core_api_get_flows_free() {
    // A GET self-API tool is a read: never gated by the CoreApi rule (smart
    // leaves it free; only the ordinary Layer-B `manual` blanket-gates it).
    let get = "ryu_api.get_api_quests";
    assert!(should_require_approval_local(&[], get, ApprovalMode::Smart, Some("smart")).is_none());
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
