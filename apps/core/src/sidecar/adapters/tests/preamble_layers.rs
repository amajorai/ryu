use super::*;

// ── ACP skill injection seam (per-agent allowlist on the ACP plane) ─────────
// The `AgentRoute::Acp` arm folds the resolved skill block into the prompt
// preamble via `merge_system_prompt` → `build_acp_prompt`. These lock that
// composition (`SkillRegistry::skill_block` itself is covered in the skills
// module tests).

#[test]
fn acp_skill_block_folds_into_prompt_preamble() {
    // Simulate `SkillRegistry::skill_block(..)` returning a header, then run the
    // exact arm logic: merge into long_term_system, then build the ACP prompt.
    let header = "## Skill: Greeter\nAlways say hello.".to_owned();
    let long_term_system = Some("You are helpful. Remembered: the user likes tea.".to_owned());
    let merged = merge_system_prompt(long_term_system, Some(header));
    let prompt = build_acp_prompt(merged, None, "what's the weather?");
    // Skill instructions reach the ACP subprocess as a leading preamble...
    assert!(
        prompt.starts_with("## Skill: Greeter"),
        "skill block leads the preamble: {prompt}"
    );
    assert!(prompt.contains("Always say hello."));
    // ...alongside the existing persona/memory context and the user message.
    assert!(prompt.contains("the user likes tea."));
    assert!(prompt.contains("what's the weather?"));
}

#[test]
fn append_turn_context_joins_in_order_and_skips_blanks() {
    let joined = append_turn_context(Some("memory".to_owned()), Some("recall".to_owned()));
    assert_eq!(joined.as_deref(), Some("memory\n\nrecall"));
    assert_eq!(
        append_turn_context(None, Some("recall".to_owned())).as_deref(),
        Some("recall")
    );
    assert_eq!(
        append_turn_context(Some("memory".to_owned()), Some("  ".to_owned())).as_deref(),
        Some("memory")
    );
    assert_eq!(append_turn_context(Some(String::new()), None), None);
}

#[test]
fn turn_context_leaves_the_cached_prefix_byte_identical() {
    // Two turns of one conversation whose recall differs. Only the newest user
    // message may change; the system block and earlier history must not, or
    // the provider prompt cache misses from the first token.
    let turn = |recall: &str, question: &str| {
        let mut messages = vec![
            serde_json::json!({ "role": "system", "content": "persona + docs" }),
            serde_json::json!({ "role": "user", "content": "earlier question" }),
            serde_json::json!({ "role": "assistant", "content": "earlier answer" }),
            serde_json::json!({ "role": "user", "content": question }),
        ];
        let context = append_turn_context(Some("memory".to_owned()), Some(recall.to_owned()));
        if let Some(context) = context.as_deref() {
            append_ephemeral_turn_context(&mut messages, context);
        }
        messages
    };
    let first = turn("recall about tea", "what now?");
    let second = turn("recall about coffee", "and then?");
    assert_eq!(first[..3], second[..3]);
    assert_eq!(
        first[3]["content"],
        "what now?\n\nmemory\n\nrecall about tea"
    );
}

#[test]
fn acp_turn_delta_carries_query_context_after_the_user_text() {
    let delta = acp_turn_delta(
        "/plan\nrefactor the parser",
        Some("recalled: parser lives in src/parse.rs".to_owned()),
        Some("capability hint".to_owned()),
    );
    assert!(delta.starts_with("/plan\n"), "{delta}");
    assert!(
        delta.ends_with("parser\n\nrecalled: parser lives in src/parse.rs\n\ncapability hint"),
        "{delta}"
    );
    assert_eq!(acp_turn_delta("hi", None, None), "hi");
    assert_eq!(acp_turn_delta("hi", Some(" ".to_owned()), None), "hi");
}

#[test]
fn acp_turn_context_follows_the_reusable_prefix() {
    let context = append_turn_context(
        Some("recalled: likes tea".to_owned()),
        Some("capability hint".to_owned()),
    );
    let prompt = build_acp_prompt_with_turn_context(
        Some("persona".to_owned()),
        Some("Conversation so far:\nuser: hi".to_owned()),
        context.as_deref(),
        "what now?",
    );
    assert!(
        prompt.starts_with("persona\n\nConversation so far:"),
        "{prompt}"
    );
    assert!(
        prompt.ends_with("recalled: likes tea\n\ncapability hint\n\nwhat now?"),
        "{prompt}"
    );
}

#[test]
fn acp_no_skill_block_leaves_preamble_unchanged() {
    // The `None` arm (empty allowlist + no enabled skills) must not alter the
    // preamble: the long_term_system passes through verbatim.
    let long_term_system = Some("Just the memory block.".to_owned());
    let merged = merge_system_prompt(long_term_system.clone(), None);
    assert_eq!(merged, long_term_system);
    let prompt = build_acp_prompt(merged, None, "hi");
    assert!(prompt.starts_with("Just the memory block."));
    assert!(!prompt.contains("## Skill:"));
}

// ── Ryu docs pointer (standing preamble layer) ─────────────────────────────
// `route_chat_stream` merges `ryu_docs_hint()` once, before the plane branch,
// with the hint as the FIRST argument so it lands at the TAIL of the block.
// These lock that placement — a future layer merged in the wrong argument
// slot would push the hint above the user's own persona/memory/style, which
// is the failure this ordering exists to prevent.

#[test]
fn ryu_docs_hint_appends_after_user_configured_layers() {
    let long_term_system = Some("Your name is Ada.\n\nRemembered: the user likes tea.".to_owned());
    let merged = merge_system_prompt(ryu_docs_hint_when(false), long_term_system)
        .expect("the hint alone is enough to produce a block");
    assert!(
        merged.starts_with("Your name is Ada."),
        "persona still leads the block: {merged}"
    );
    assert!(
        merged
            .trim_end()
            .ends_with("unless they ask for the technical detail."),
        "the docs hint is last: {merged}"
    );
    assert!(merged.contains("https://docs.ryuhq.com/llms.txt"));

    // Every layer merged AFTER this one prepends, so the hint stays at the tail.
    let with_skills =
        merge_system_prompt(Some(merged), Some("## Skill: Greeter".to_owned())).unwrap();
    assert!(with_skills.starts_with("## Skill: Greeter"));
    assert!(with_skills
        .trim_end()
        .ends_with("unless they ask for the technical detail."));
}

#[test]
fn ryu_docs_hint_is_the_whole_block_when_nothing_else_is_configured() {
    // No persona, no memory, no recall: the `(Some(e), None)` arm must keep the
    // hint rather than collapsing it to `None`.
    let merged = merge_system_prompt(ryu_docs_hint_when(false), None);
    assert_eq!(merged.as_deref(), Some(RYU_DOCS_HINT));
}

#[test]
fn safe_mode_suppresses_the_ryu_docs_hint() {
    assert!(
        ryu_docs_hint_when(true).is_none(),
        "safe mode ships a baseline turn with nothing extra in the prompt"
    );
    assert_eq!(ryu_docs_hint_when(false).as_deref(), Some(RYU_DOCS_HINT));
    // And suppression must leave the rest of the block untouched.
    let long_term_system = Some("Just the memory block.".to_owned());
    assert_eq!(
        merge_system_prompt(ryu_docs_hint_when(true), long_term_system.clone()),
        long_term_system
    );
}

// ── Project instructions (AGENTS.md / CLAUDE.md) ───────────────────────────
// `route_chat_stream` merges `project_instructions_hint()` (when a workspace
// folder is active) as the SECOND argument so it LEADS the assembled block,
// and suppresses it under Safe Mode exactly like the docs hint.

fn temp_project_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-pi-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("AGENTS.md"), "# Repo rules\nbuild with bun\n").unwrap();
    dir
}

#[test]
fn project_instructions_block_is_formed_and_leads() {
    let dir = temp_project_dir();
    let block = project_instructions_hint_when(false, Some(&dir.to_string_lossy()))
        .expect("a project with AGENTS.md yields a block");
    assert!(
        block.starts_with("## Project instructions (AGENTS.md)"),
        "{block}"
    );
    assert!(block.contains("build with bun"));
    // Merged as the second argument it lands on TOP of the user's block.
    let merged = merge_system_prompt(
        Some("Your name is Ada.".to_owned()),
        project_instructions_hint_when(false, Some(&dir.to_string_lossy())),
    )
    .unwrap();
    assert!(merged.starts_with("## Project instructions"), "{merged}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn project_instructions_absent_without_folder_or_in_safe_mode() {
    assert!(project_instructions_hint_when(false, None).is_none());
    assert!(project_instructions_hint_when(true, Some("/tmp")).is_none());
}

#[test]
fn team_nodes_do_not_receive_personalization() {
    use crate::server::onboarding_state::NodeSetupKind;

    assert!(!should_include_user_personalization(
        Some(NodeSetupKind::Team),
        None,
        false
    ));
    assert!(should_include_user_personalization(
        Some(NodeSetupKind::Personal),
        Some(crate::sidecar::control_plane::NodeScope::Personal),
        false
    ));
    assert!(should_include_user_personalization(None, None, false));
    assert!(!should_include_user_personalization(
        Some(NodeSetupKind::Personal),
        Some(crate::sidecar::control_plane::NodeScope::Org),
        false
    ));
    assert!(!should_include_user_personalization(
        Some(NodeSetupKind::Personal),
        Some(crate::sidecar::control_plane::NodeScope::Personal),
        true
    ));
}
