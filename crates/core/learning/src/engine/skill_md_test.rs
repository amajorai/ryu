use super::config::LEARNED_SKILL_PREFIX;
use super::skill_md::extract_json_object;
use super::{build_skill_md, slugify, SkillProvenance};

#[test]
fn slugify_is_namespaced_and_safe() {
    assert_eq!(slugify("Reverse a String!"), "learned-reverse-a-string");
    assert_eq!(slugify("  spaces  here  "), "learned-spaces-here");
    assert!(slugify("a").starts_with(LEARNED_SKILL_PREFIX));
}

#[test]
fn build_skill_md_round_trips_through_parser() {
    let md = build_skill_md(
        "Reverse a string",
        "When you need to reverse a string in Rust",
        "Use `s.chars().rev().collect::<String>()`.",
        &SkillProvenance {
            conversation_id: "conv-1".into(),
            agent_id: Some("agent-7".into()),
            requested_by: Some("user-42".into()),
            user_requested: true,
            synthesized_at: "2026-07-23T00:00:00Z".into(),
            revises: Some("learned-reverse-text".into()),
        },
    );
    let parsed = ryu_skills::parse_skill_md("learned-x", &md).expect("valid skill");
    assert_eq!(parsed.name, "Reverse a string");
    assert!(parsed.instructions.contains("rev()"));
    // Provenance is stamped into the front-matter (never the instruction
    // body), so the approver/auditor sees origin without the skill's runtime
    // behavior changing.
    assert!(md.contains("source-conversation: conv-1\n"));
    assert!(md.contains("source-agent: agent-7\n"));
    assert!(md.contains("requested-by: user-42\n"));
    assert!(md.contains("origin: user-requested\n"));
    assert!(md.contains("synthesized-at: 2026-07-23T00:00:00Z\n"));
    assert!(md.contains("revises: learned-reverse-text\n"));
    assert!(!parsed.instructions.contains("source-conversation"));
}

#[test]
fn build_skill_md_omits_absent_provenance_fields() {
    let md = build_skill_md(
        "Skill",
        "Desc",
        "Body",
        &SkillProvenance {
            conversation_id: "conv-2".into(),
            synthesized_at: "2026-07-23T00:00:00Z".into(),
            ..Default::default()
        },
    );
    ryu_skills::parse_skill_md("learned-y", &md).expect("valid skill");
    assert!(md.contains("origin: auto\n"));
    assert!(!md.contains("source-agent"));
    assert!(!md.contains("requested-by"));
    assert!(!md.contains("revises"));
}

#[test]
fn extract_json_object_strips_fences() {
    let v = extract_json_object("here you go:\n```json\n{\"name\":\"x\",\"a\":1}\n```\n").unwrap();
    assert_eq!(v["name"], "x");
    assert_eq!(v["a"], 1);
}

#[test]
fn extract_json_object_handles_braces_in_strings() {
    let v = extract_json_object("{\"instructions\":\"use HashMap<K,{V}>\"}").unwrap();
    assert_eq!(v["instructions"], "use HashMap<K,{V}>");
}

#[test]
fn extract_json_object_skips_prose_brace() {
    // First `{...}` is prose and won't parse; the real object comes later.
    let v = extract_json_object(
        "Use {placeholders} like this: {\"name\":\"foo\",\"instructions\":\"x\"}",
    )
    .unwrap();
    assert_eq!(v["name"], "foo");
}
