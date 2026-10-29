use super::*;

// ── Output-style injection (docs/output-styles.md §5) ──────────────────────
//
// Two things are pinned here: what `keep-coding-instructions` does to the agent's
// base instructions (§2), and WHERE the style lands relative to the skills block
// on each plane. The parser and the adherence reminder are the crate's tests;
// these cover only the composition this module owns.

/// Parse a real style file, so the tests exercise the same parser a `.md` on disk
/// and a plugin contribution both go through.
fn test_style(md: &str) -> ryu_output_styles::OutputStyleRecord {
    ryu_output_styles::parse_output_style_md("eli5", md).expect("test style parses")
}

const KEEP_STYLE: &str =
    "---\nname: ELI5\nkeep-coding-instructions: true\n---\n\nTalk to me like I'm 5.";
const REPLACE_STYLE: &str =
    "---\nname: Plain text\nkeep-coding-instructions: false\n---\n\nNo markdown, prose only.";

#[test]
fn agent_personality_profile_resolves_after_a_one_turn_override() {
    let registry = ryu_output_styles::OutputStyleRegistry::empty();
    registry
        .register_plugin_style("eli5".to_owned(), KEEP_STYLE)
        .expect("agent profile style registers");
    registry
        .register_plugin_style("plain-text".to_owned(), REPLACE_STYLE)
        .expect("one-turn style registers");

    let persisted = resolve_output_style(&registry, None, Some("eli5"))
        .expect("the agent profile should resolve");
    assert_eq!(persisted.id, "eli5");

    let override_style = resolve_output_style(&registry, Some("plain-text"), Some("eli5"))
        .expect("the explicit turn override should resolve");
    assert_eq!(override_style.id, "plain-text");
}

#[test]
fn missing_agent_personality_profile_does_not_fall_back_to_a_node_style() {
    let registry = ryu_output_styles::OutputStyleRegistry::empty();
    registry
        .register_plugin_style("eli5".to_owned(), KEEP_STYLE)
        .expect("style registers");

    assert!(resolve_output_style(&registry, None, None).is_none());
    assert!(resolve_output_style(&registry, None, Some("missing")).is_none());
}

#[test]
fn keep_coding_instructions_appends_the_style_after_base_instructions() {
    let prefix = output_style_prefix(&test_style(KEEP_STYLE), Some("You review Rust code."))
        .expect("a style with a body injects something");
    // Base instructions lead, the style body follows: BOTH apply (§2).
    assert!(
        prefix.starts_with("You review Rust code."),
        "base instructions lead: {prefix}"
    );
    assert!(prefix.contains("Talk to me like I'm 5."));
    assert!(
        prefix.find("You review Rust code.") < prefix.find("Talk to me like I'm 5."),
        "the style body is appended AFTER the base instructions: {prefix}"
    );
}

#[test]
fn keep_coding_instructions_false_replaces_base_instructions() {
    let prefix = output_style_prefix(&test_style(REPLACE_STYLE), Some("You review Rust code."))
        .expect("a style with a body injects something");
    assert!(
        !prefix.contains("You review Rust code."),
        "the default replaces the agent's base instructions: {prefix}"
    );
    assert!(prefix.starts_with("No markdown, prose only."));
    // Replacing is not "drop the reminder too" — the block is still the crate's.
    assert_eq!(
        prefix,
        ryu_output_styles::style_block(&test_style(REPLACE_STYLE))
    );
}

#[test]
fn a_body_less_style_injects_nothing_at_all() {
    // Frontmatter-only file: listable in the picker, but there is nothing to
    // inject, so the seams must see `None` rather than a bare reminder.
    let record = test_style("---\nname: Empty\ndescription: nothing here\n---\n");
    assert_eq!(
        output_style_prefix(&record, Some("You review Rust code.")),
        None
    );
}

#[test]
fn no_output_style_leaves_the_acp_preamble_byte_identical() {
    // The inert case, which is the shipped default (§8: an agent has no profile).
    // Both arms of the ACP seam must produce exactly today's prompt.
    let long_term_system =
        merge_system_prompt(Some("Remembered: the user likes tea.".to_owned()), None);
    let with_skills = merge_system_prompt(long_term_system, Some("## Skill: Greeter".to_owned()));
    let baseline = build_acp_prompt(with_skills.clone(), None, "hi");
    // ...and now the style line the arm actually runs, with nothing selected.
    let styled = merge_system_prompt(with_skills, None);
    assert_eq!(build_acp_prompt(styled, None, "hi"), baseline);
}

#[test]
fn output_style_leads_the_acp_preamble_ahead_of_the_skills_block() {
    // The exact `AgentRoute::Acp` arm order: memory/persona, then the skills
    // merge, then the style merge. `merge_system_prompt` PREPENDS its second
    // argument, so applying the style last is what puts it FIRST in the text.
    let style_prefix = output_style_prefix(&test_style(KEEP_STYLE), Some("You review Rust code."));
    let long_term_system = Some("Remembered: the user likes tea.".to_owned());
    let with_skills = merge_system_prompt(
        long_term_system,
        Some("## Skill: Greeter\nAlways say hello.".to_owned()),
    );
    let merged = merge_system_prompt(with_skills, style_prefix);
    let prompt = build_acp_prompt(merged, None, "what's the weather?");

    let base_at = prompt
        .find("You review Rust code.")
        .expect("base instructions");
    let style_at = prompt.find("Talk to me like I'm 5.").expect("style body");
    let skills_at = prompt.find("## Skill: Greeter").expect("skills block");
    let memory_at = prompt.find("the user likes tea.").expect("memory block");
    // base instructions → style body → skills block → memory (§5). The style
    // sits BEFORE the skills block on purpose: a skill's own formatting
    // instructions are task-specific and must win over the style's general shape.
    assert!(
        base_at < style_at && style_at < skills_at && skills_at < memory_at,
        "wrong assembly order: {prompt}"
    );
    assert!(prompt.ends_with("what's the weather?"));
}

#[test]
fn agent_instructions_reach_the_prompt_unless_a_style_owns_them() {
    let instructions = "  You answer questions about the release process.  ";
    assert_eq!(
        agent_instructions_layer(Some(instructions), false).as_deref(),
        Some("You answer questions about the release process.")
    );
    // A style with a body carries (keep) or replaces (default) them itself.
    assert_eq!(agent_instructions_layer(Some(instructions), true), None);
    assert_eq!(agent_instructions_layer(Some("   "), false), None);
    assert_eq!(agent_instructions_layer(None, false), None);
}

#[tokio::test]
async fn seeded_built_in_instructions_reach_the_acp_prompt() {
    // Jay Jr.'s persona and guardrails are seeded into its record's
    // `system_prompt`, like any agent's instructions. Assembled the way
    // `route_chat_stream` does it: the persona line leads, the instructions
    // layer follows.
    let store = crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let jay = store
        .get(crate::agents::jay_jr::AGENT_ID)
        .await
        .unwrap()
        .expect("Jay Jr. is seeded");
    let layer = agent_instructions_layer(jay.system_prompt.as_deref(), false);
    let persona = persona_tone_prefix(jay.persona.as_ref());
    let system = merge_system_prompt(merge_system_prompt(None, layer), persona);
    let prompt = build_acp_prompt(system, None, "Who are you?");
    assert!(prompt.starts_with("Your name is Jay Jr."), "{prompt}");
    assert!(
        prompt.contains("You are an AI, not Jay himself."),
        "AI disclosure guardrail missing: {prompt}"
    );
    assert!(
        prompt.contains("Never make promises, commitments, deals"),
        "no-commitments guardrail missing: {prompt}"
    );
    assert!(prompt.ends_with("Who are you?"));

    // The flagship ships no instructions of its own, so nothing is added.
    let ryu = store.get("ryu").await.unwrap().expect("ryu is seeded");
    assert_eq!(
        agent_instructions_layer(ryu.system_prompt.as_deref(), false),
        None
    );
}

#[test]
fn no_output_style_leaves_the_openai_messages_byte_identical() {
    // The openai-compat twin of `no_output_style_leaves_the_acp_preamble_byte_identical`.
    // The ACP arm is inert for free (`merge_system_prompt(x, None) == x`); this arm
    // is inert only because of the `.filter(|p| !p.is_empty())` guard at the call
    // site, so the guard itself is what needs pinning. Drop it and every unstyled
    // turn — the shipped default — grows a bare adherence reminder pointing at
    // instructions that were never injected.
    let baseline = vec![
        serde_json::json!({ "role": "system", "content": "## Skill: Greeter" }),
        serde_json::json!({ "role": "user", "content": "hi" }),
    ];
    let mut messages = baseline.clone();

    // Exactly the call-site expression, with nothing selected.
    let output_style: Option<String> = None;
    if let Some(prefix) = output_style.as_deref().filter(|p| !p.is_empty()) {
        prepend_system_prefix(&mut messages, prefix);
    }
    assert_eq!(messages, baseline);

    // And the body-less-style case, which reaches the guard as `Some("")`.
    let empty = output_style_prefix(
        &test_style("---\nname: Empty\ndescription: nothing\n---\n"),
        Some("You review Rust code."),
    );
    if let Some(prefix) = empty.as_deref().filter(|p| !p.is_empty()) {
        prepend_system_prefix(&mut messages, prefix);
    }
    assert_eq!(messages, baseline);
}

#[test]
fn output_style_leads_the_system_message_ahead_of_the_skills_block_on_the_openai_plane() {
    // The openai-compat seam. The leading system message here is what
    // `inject_into_messages_filtered` has already written into (skills header
    // first, then memory), and `prepend_system_prefix` runs after it.
    let mut messages = vec![
        serde_json::json!({
            "role": "system",
            "content": "## Skill: Greeter\nAlways say hello.\n\n---\n\nRemembered: the user likes tea.",
        }),
        serde_json::json!({ "role": "user", "content": "what's the weather?" }),
    ];
    let prefix = output_style_prefix(&test_style(KEEP_STYLE), Some("You review Rust code."))
        .expect("a style with a body injects something");
    prepend_system_prefix(&mut messages, &prefix);

    let system = messages[0]["content"]
        .as_str()
        .expect("system stays a string");
    let base_at = system
        .find("You review Rust code.")
        .expect("base instructions");
    let style_at = system.find("Talk to me like I'm 5.").expect("style body");
    let skills_at = system.find("## Skill: Greeter").expect("skills block");
    let memory_at = system.find("the user likes tea.").expect("memory block");
    assert!(
        base_at < style_at && style_at < skills_at && skills_at < memory_at,
        "wrong assembly order: {system}"
    );
    // The user's turn is untouched and no extra system message appeared.
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["role"], "user");
}

#[test]
fn the_openai_seam_creates_a_system_message_and_never_clobbers_a_multimodal_one() {
    // No system message at all (no memory, no persona, no skills): one is added.
    let mut bare = vec![serde_json::json!({ "role": "user", "content": "hi" })];
    prepend_system_prefix(&mut bare, "Talk to me like I'm 5.");
    assert_eq!(bare[0]["role"], "system");
    assert_eq!(bare[0]["content"], "Talk to me like I'm 5.");

    // A client-supplied system message whose content is a parts array is NOT a
    // valid injection target — flattening it to a string would drop its parts,
    // so the style gets its own message instead.
    let parts = serde_json::json!([{ "type": "text", "text": "client preamble" }]);
    let mut multimodal = vec![
        serde_json::json!({ "role": "system", "content": parts.clone() }),
        serde_json::json!({ "role": "user", "content": "hi" }),
    ];
    prepend_system_prefix(&mut multimodal, "Talk to me like I'm 5.");
    assert_eq!(multimodal[0]["content"], "Talk to me like I'm 5.");
    assert_eq!(multimodal[1]["content"], parts, "the parts array survives");
}

// ── Agent profile selection (§5) ───────────────────────────────────────────
//
// Built against a local registry rather than the process-global handle, which is
// a `OnceLock` a test cannot re-set (and would leak into every other test in the
// binary). `register_plugin_style` takes whole-file markdown, so these also pin
// that the profile selection compares ids, not names.

fn styles_registry(entries: &[(&str, &str)]) -> ryu_output_styles::OutputStyleRegistry {
    let registry = ryu_output_styles::OutputStyleRegistry::empty();
    for (id, md) in entries {
        registry
            .register_plugin_style((*id).to_owned(), md)
            .expect("test style registers");
    }
    registry
}

#[test]
fn the_most_specific_profile_selection_wins() {
    let registry = styles_registry(&[
        ("turn", "---\nname: Turn\n---\nbody"),
        ("agent", "---\nname: Agent\n---\nbody"),
    ]);
    let pick = |t, a| resolve_output_style(&registry, t, a).map(|r| r.id);
    assert_eq!(pick(Some("turn"), Some("agent")).as_deref(), Some("turn"));
    assert_eq!(pick(None, Some("agent")).as_deref(), Some("agent"));
    assert_eq!(pick(None, None), None);
    // Blank is not a selection — an empty string reaching the tier from a
    // client body must not shadow the persisted agent profile.
    assert_eq!(pick(Some("  "), Some("agent")).as_deref(), Some("agent"));
}

#[test]
fn a_selected_style_that_no_longer_exists_falls_through() {
    // Deleted style / disabled plugin / stale profile state. A dangling id
    // carries no intent to suppress the agent's own voice.
    let registry = styles_registry(&[("agent", "---\nname: Agent\n---\nbody")]);
    assert_eq!(
        resolve_output_style(&registry, Some("deleted"), Some("agent")).map(|r| r.id),
        Some("agent".to_owned())
    );
    assert_eq!(
        resolve_output_style(&registry, Some("deleted"), None).map(|r| r.id),
        None
    );
}

#[test]
fn a_forced_plugin_style_beats_every_tier() {
    let registry = styles_registry(&[
        ("turn", "---\nname: Turn\n---\nbody"),
        (
            "forced",
            "---\nname: Forced\nforce-for-plugin: true\n---\nbody",
        ),
    ]);
    assert_eq!(
        resolve_output_style(&registry, Some("turn"), Some("turn")).map(|r| r.id),
        Some("forced".to_owned()),
        "force-for-plugin overrides the turn and agent profile while its plugin is enabled"
    );
}
