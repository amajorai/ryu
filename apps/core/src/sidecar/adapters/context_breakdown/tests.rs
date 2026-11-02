use super::*;
use serde_json::json;

fn tool(id: &str, description: &str) -> RegistryTool {
    let mut t = RegistryTool::candidate(id, "srv", id);
    t.description = Some(description.to_owned());
    t.input_schema = Some(json!({"type": "object", "properties": {}}));
    t
}

#[test]
fn empty_builder_emits_nothing() {
    assert!(BreakdownBuilder::new().finish(ContextPlane::Acp).is_none());
}

#[test]
fn zero_token_layers_are_dropped() {
    let mut b = BreakdownBuilder::new();
    b.add_text("skills", "Skills", None);
    b.add_text("persona", "Persona", Some(""));
    b.add_text("memory", "Memory", Some("remembered fact"));
    let out = b.finish(ContextPlane::Openai).expect("one non-empty layer");
    assert_eq!(out.segments.len(), 1);
    assert_eq!(out.segments[0].kind, "memory");
}

#[test]
fn segments_sort_largest_first_and_sum_to_attributed() {
    let mut b = BreakdownBuilder::new();
    b.add("persona", "Persona", 10);
    b.add("skills", "Skills", 900);
    b.add("memory", "Memory", 100);
    let out = b.finish(ContextPlane::Openai).expect("segments");
    let kinds: Vec<_> = out.segments.iter().map(|s| s.kind).collect();
    assert_eq!(kinds, vec!["skills", "memory", "persona"]);
    assert_eq!(out.attributed, 1010);
}

#[test]
fn tool_definitions_are_costed_and_servers_counted() {
    let mut b = BreakdownBuilder::new();
    let mut second = tool("b", "does another thing");
    second.server = "other".to_owned();
    b.add_tools(&[tool("a", "does a thing"), second]);
    let out = b.finish(ContextPlane::Acp).expect("tool segment");
    assert_eq!(out.segments[0].kind, "tools");
    assert!(out.segments[0].tokens > 0);
    assert_eq!(
        out.segments[0].detail.as_deref(),
        Some("2 tools across 2 servers")
    );
    let wire = serde_json::to_value(&out.segments[0]).unwrap();
    assert_eq!(wire["labelKey"], json!("tool_definitions"));
    assert_eq!(wire["detailKey"], json!("tools"));
    assert_eq!(wire["counts"], json!({"servers": 2, "tools": 2}));
}

#[test]
fn message_counts_and_label_keys_are_structured() {
    let mut b = BreakdownBuilder::new();
    b.add_detailed(
        "messages",
        "Conversation history",
        5,
        Some(SegmentDetail::ReplayedTurns),
    );
    b.add_detailed("skills", "Skills", 9, Some(SegmentDetail::Skills(1)));
    b.add("system", "Some future layer", 3);
    let out = b.finish(ContextPlane::Acp).expect("segments");
    let wire = serde_json::to_value(&out.segments).unwrap();
    assert_eq!(wire[0]["labelKey"], json!("skills"));
    assert_eq!(wire[0]["detail"], json!("1 enabled"));
    assert_eq!(wire[0]["counts"], json!({"skills": 1}));
    assert_eq!(wire[1]["detailKey"], json!("replayed_turns"));
    assert!(wire[1].get("counts").is_none());
    assert_eq!(wire[1]["labelKey"], json!("conversation_history"));
    assert!(
        wire[2].get("labelKey").is_none(),
        "unknown label keeps English only"
    );
    assert_eq!(wire[2]["label"], json!("Some future layer"));
}

#[test]
fn first_detail_wins_when_a_kind_is_charged_twice() {
    let mut b = BreakdownBuilder::new();
    b.add("messages", "Conversation history", 4);
    b.add_detailed(
        "messages",
        "Conversation history",
        6,
        Some(SegmentDetail::Messages(1)),
    );
    b.add_detailed(
        "messages",
        "Conversation history",
        6,
        Some(SegmentDetail::Messages(7)),
    );
    let out = b.finish(ContextPlane::Acp).expect("segments");
    assert_eq!(out.segments[0].tokens, 16);
    assert_eq!(out.segments[0].detail.as_deref(), Some("1 message"));
    assert_eq!(out.segments[0].counts.clone().unwrap().messages, Some(1));
}

#[test]
fn no_tools_adds_no_segment() {
    let mut b = BreakdownBuilder::new();
    b.add_tools(&[]);
    assert!(b.finish(ContextPlane::Acp).is_none());
}

#[test]
fn plane_and_window_ride_along() {
    let mut b = BreakdownBuilder::new();
    b.set_window(8192);
    b.set_reserve_output(1024);
    b.add("skills", "Skills", 42);
    let out = b.finish(ContextPlane::Acp).expect("segments");
    assert_eq!(out.window, 8192);
    assert_eq!(out.reserve_output, 1024);
    assert_eq!(out.plane, ContextPlane::Acp);
    assert_eq!(
        serde_json::to_value(out.plane).unwrap(),
        serde_json::json!("acp")
    );
}

#[test]
fn remembering_replaces_and_evicts_oldest() {
    let mk = |tokens: usize| {
        let mut b = BreakdownBuilder::new();
        b.add("skills", "Skills", tokens);
        b.finish(ContextPlane::Acp).expect("segments")
    };
    // Unique ids so this test cannot collide with a sibling test's writes
    // into the process-global store.
    let id = |i: usize| format!("evict-conv-{i}");

    record(&id(0), mk(1));
    record(&id(0), mk(2));
    assert_eq!(remembered(&id(0)).expect("kept").attributed, 2);

    for i in 1..=MAX_REMEMBERED {
        record(&id(i), mk(3));
    }
    assert!(remembered(&id(0)).is_none(), "oldest evicted");
    assert!(remembered(&id(MAX_REMEMBERED)).is_some(), "newest kept");
}
