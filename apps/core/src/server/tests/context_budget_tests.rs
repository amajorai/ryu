use crate::agents::{CompactionSettings, CompactionThreshold, MemorySlot};
use crate::server::{
    agent_compaction_budget_raw, apply_agent_compaction_model, parse_context_budget,
    pick_context_budget_raw,
};

#[test]
fn agent_compaction_overrides_threshold_and_summarizer() {
    assert_eq!(agent_compaction_budget_raw(None), None);
    let settings = CompactionSettings {
        enabled: Some(true),
        threshold: Some(CompactionThreshold::Tokens(6000)),
        model: Some(" small-model ".to_owned()),
        effort: None,
    };
    assert_eq!(
        agent_compaction_budget_raw(Some(&settings)).as_deref(),
        Some("6000")
    );
    assert_eq!(
        apply_agent_compaction_model(Some(&settings), "node".into(), "low".into()),
        ("small-model".to_owned(), "low".to_owned())
    );
    let auto = CompactionSettings {
        threshold: Some(CompactionThreshold::Keyword(" AUTO ".to_owned())),
        model: Some("  ".to_owned()),
        ..Default::default()
    };
    assert_eq!(
        agent_compaction_budget_raw(Some(&auto)).as_deref(),
        Some("auto")
    );
    // A blank model override keeps the node's summarizer.
    assert_eq!(
        apply_agent_compaction_model(Some(&auto), "node".into(), String::new()),
        ("node".to_owned(), String::new())
    );
    assert_eq!(
        apply_agent_compaction_model(None, "node".into(), "high".into()),
        ("node".to_owned(), "high".to_owned())
    );
}

#[test]
fn memory_slot_compaction_and_working_memory_round_trip_and_validate() {
    let slot: MemorySlot = serde_json::from_value(serde_json::json!({
        "working_memory": { "scope": "resource", "schema": { "type": "object" } },
        "compaction": { "threshold": 8000, "model": "m" }
    }))
    .unwrap();
    assert!(slot.validate().is_ok());
    assert_eq!(
        slot.compaction.as_ref().and_then(|c| c.threshold.clone()),
        Some(CompactionThreshold::Tokens(8000))
    );
    let encoded = serde_json::to_value(&slot).unwrap();
    assert_eq!(encoded["working_memory"]["scope"], "resource");
    let bad: MemorySlot = serde_json::from_value(serde_json::json!({
        "compaction": { "threshold": "sometimes" }
    }))
    .unwrap();
    assert!(bad.validate().is_err());
    let zero: MemorySlot =
        serde_json::from_value(serde_json::json!({ "compaction": { "threshold": 0 } })).unwrap();
    assert!(zero.validate().is_err());
    let bad_schema: MemorySlot = serde_json::from_value(serde_json::json!({
        "working_memory": { "schema": { "type": "array" } }
    }))
    .unwrap();
    assert!(bad_schema.validate().is_err());
}

#[test]
fn engine_scope_wins_over_local_and_global() {
    let raw = pick_context_budget_raw(Some("4096"), Some("auto"), true, Some("off"), None);
    assert_eq!(raw, "4096");
}

#[test]
fn local_scope_applies_only_to_local_engines() {
    assert_eq!(
        pick_context_budget_raw(None, Some("auto"), true, None, None),
        "auto"
    );
    // A cloud turn ignores the local-only key and keeps the global (off).
    assert_eq!(
        pick_context_budget_raw(None, Some("auto"), false, None, None),
        ""
    );
}

#[test]
fn blank_scopes_fall_through_but_explicit_off_does_not() {
    assert_eq!(
        pick_context_budget_raw(Some("  "), None, true, Some("8000"), None),
        "8000"
    );
    assert_eq!(
        pick_context_budget_raw(None, Some("off"), true, Some("8000"), None),
        "off"
    );
    assert_eq!(
        pick_context_budget_raw(None, None, false, None, Some(" 2048 ")),
        "2048"
    );
    // A set-but-blank global pref still shadows the env fallback.
    assert_eq!(
        pick_context_budget_raw(None, None, false, Some(""), Some("2048")),
        ""
    );
}

#[test]
fn off_values_disable() {
    assert_eq!(parse_context_budget("", Some(8192)), None);
    assert_eq!(parse_context_budget("0", Some(8192)), None);
    assert_eq!(parse_context_budget("off", Some(8192)), None);
    assert_eq!(parse_context_budget("  OFF ", Some(8192)), None);
}

#[test]
fn auto_sizes_to_ctx_size_else_off() {
    assert_eq!(parse_context_budget("auto", Some(8192)), Some(8192));
    assert_eq!(parse_context_budget("AUTO", Some(4096)), Some(4096));
    // Unknown / zero ctx_size → feature stays off (no guessable budget).
    assert_eq!(parse_context_budget("auto", None), None);
    assert_eq!(parse_context_budget("auto", Some(0)), None);
}

#[test]
fn numeric_is_explicit_budget_and_ignores_ctx_size() {
    assert_eq!(parse_context_budget("3500", None), Some(3500));
    assert_eq!(parse_context_budget(" 12000 ", Some(8192)), Some(12000));
    // Garbage / non-positive → off.
    assert_eq!(parse_context_budget("abc", Some(8192)), None);
    assert_eq!(parse_context_budget("-5", Some(8192)), None);
}
