//! The per-turn `<working_memory>` context block.

use super::*;
use serde_json::json;

#[test]
fn render_block_seeds_template_and_shows_schema_state() {
    let config = WorkingMemoryConfig {
        enabled: true,
        scope: WorkingMemoryScope::Thread,
        template: Some("# Task\n- goal:".into()),
        schema: None,
    };
    let empty = render_working_memory_block(None, &config, "update_working_memory");
    assert!(empty.contains("# Task\n- goal:"));
    assert!(empty.contains("update_working_memory"));
    assert!(empty.starts_with("<working_memory>"));

    let doc = WorkingMemory {
        scope: WorkingMemoryScope::Resource,
        id: "u".into(),
        mode: WorkingMemoryMode::Schema,
        content: None,
        data: Some(json!({ "name": "Ada" })),
        template: None,
        schema: Some(json!({ "type": "object" })),
        version: 3,
        created_at: 1,
        updated_at: 2,
    };
    let schema_config = WorkingMemoryConfig {
        scope: WorkingMemoryScope::Resource,
        schema: Some(json!({ "type": "object" })),
        ..Default::default()
    };
    let rendered = render_working_memory_block(Some(&doc), &schema_config, "update_working_memory");
    assert!(rendered.contains("\"name\": \"Ada\""));
    assert!(rendered.contains("merge patch"));
    assert!(rendered.contains("across conversations"));

    // A stored document in the other mode is not shown with instructions the
    // agent's update tool cannot follow.
    let template_config = WorkingMemoryConfig {
        scope: WorkingMemoryScope::Resource,
        template: Some("# Profile".into()),
        ..Default::default()
    };
    let mismatched =
        render_working_memory_block(Some(&doc), &template_config, "update_working_memory");
    assert!(mismatched.contains("`content`"));
    assert!(mismatched.contains("# Profile"));
    assert!(!mismatched.contains("\"name\": \"Ada\""));
}

#[test]
fn render_block_shows_the_version_to_send_back() {
    let config = WorkingMemoryConfig {
        scope: WorkingMemoryScope::Thread,
        ..Default::default()
    };
    let empty = render_working_memory_block(None, &config, "update_working_memory");
    assert!(empty.contains("This is version 0: pass `expected_version: 0`"));
    assert!(empty.contains("merge your change"));

    let mut doc = WorkingMemory {
        scope: WorkingMemoryScope::Thread,
        id: "t".into(),
        mode: WorkingMemoryMode::Template,
        content: Some("# Notes".into()),
        data: None,
        template: None,
        schema: None,
        version: 7,
        created_at: 1,
        updated_at: 2,
    };
    let stored = render_working_memory_block(Some(&doc), &config, "update_working_memory");
    assert!(stored.contains("`expected_version: 7`"));
    assert!(stored.contains("# Notes"));

    // A document in the other mode is hidden, but its stored version is still
    // the one a write must name.
    doc.mode = WorkingMemoryMode::Schema;
    doc.version = 4;
    let hidden = render_working_memory_block(Some(&doc), &config, "update_working_memory");
    assert!(!hidden.contains("# Notes"));
    assert!(hidden.contains("`expected_version: 4`"));
}
