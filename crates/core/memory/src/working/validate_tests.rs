//! Working-memory merge patches and configuration validation.

use super::*;
use serde_json::json;

#[test]
fn merge_patch_follows_rfc7386() {
    let merged = merge_patch(
        json!({ "a": "b", "c": { "d": "e", "f": "g" } }),
        json!({ "a": "z", "c": { "f": null } }),
        0,
    )
    .unwrap();
    assert_eq!(merged, json!({ "a": "z", "c": { "d": "e" } }));
    assert_eq!(
        merge_patch(json!({ "a": 1 }), json!([1]), 0).unwrap(),
        json!([1])
    );
}

#[test]
fn config_parses_and_selects_mode() {
    let config: WorkingMemoryConfig =
        serde_json::from_value(json!({ "scope": "resource" })).unwrap();
    assert!(config.enabled);
    assert_eq!(config.scope, WorkingMemoryScope::Resource);
    assert_eq!(config.mode(), WorkingMemoryMode::Template);
    let schema_config: WorkingMemoryConfig =
        serde_json::from_value(json!({ "schema": { "type": "object" } })).unwrap();
    assert_eq!(schema_config.scope, WorkingMemoryScope::Thread);
    assert_eq!(schema_config.mode(), WorkingMemoryMode::Schema);
    assert!(schema_config.validate().is_ok());
    assert!(WorkingMemoryConfig {
        schema: Some(json!(["not", "an", "object"])),
        ..Default::default()
    }
    .validate()
    .is_err());
    assert_eq!(
        WorkingMemoryScope::parse("thread"),
        Some(WorkingMemoryScope::Thread)
    );
    assert_eq!(WorkingMemoryScope::parse("org"), None);
}
