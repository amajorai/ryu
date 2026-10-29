use super::*;

// ── PartsAccumulator: streaming-chunk reduction into persisted parts ─────
//
// The accumulator mirrors the AI SDK client's frame reduction so the row
// persisted to `messages.parts` is byte-for-byte what the client built live.
// These pin that reduction directly (the big streaming loop exercises it only
// end-to-end).

#[test]
fn parts_text_deltas_coalesce_per_block_id() {
    let mut acc = PartsAccumulator::default();
    assert!(acc.is_empty());
    acc.text_delta("0", "Hel");
    acc.text_delta("0", "lo");
    acc.text_delta("0", " world");
    // One text part for block "0", concatenated in order.
    assert_eq!(acc.parts.len(), 1);
    assert_eq!(acc.parts[0]["type"], serde_json::json!("text"));
    assert_eq!(acc.parts[0]["text"], serde_json::json!("Hello world"));
    assert!(!acc.is_empty());
}

#[test]
fn parts_distinct_block_ids_open_distinct_text_parts() {
    let mut acc = PartsAccumulator::default();
    acc.text_delta("0", "first");
    acc.text_delta("1", "second");
    acc.text_delta("0", "-more");
    assert_eq!(acc.parts.len(), 2);
    assert_eq!(acc.parts[0]["text"], serde_json::json!("first-more"));
    assert_eq!(acc.parts[1]["text"], serde_json::json!("second"));
}

#[test]
fn parts_tool_input_opens_static_vs_dynamic_shape() {
    let mut acc = PartsAccumulator::default();
    acc.tool_input(
        "call-a",
        "search",
        &serde_json::json!({ "q": "x" }),
        false,
        None,
    );
    acc.tool_input(
        "call-b",
        "custom",
        &serde_json::json!({ "n": 1 }),
        true,
        None,
    );

    // Static tool → `tool-<name>` type, no `toolName` field.
    assert_eq!(acc.parts[0]["type"], serde_json::json!("tool-search"));
    assert_eq!(acc.parts[0]["toolCallId"], serde_json::json!("call-a"));
    assert_eq!(acc.parts[0]["state"], serde_json::json!("input-available"));
    assert!(acc.parts[0].get("toolName").is_none());

    // Dynamic tool → `dynamic-tool` type carrying `toolName`.
    assert_eq!(acc.parts[1]["type"], serde_json::json!("dynamic-tool"));
    assert_eq!(acc.parts[1]["toolName"], serde_json::json!("custom"));
    assert_eq!(acc.parts[1]["toolCallId"], serde_json::json!("call-b"));
}

#[test]
fn parts_tool_input_reemit_updates_input_in_place() {
    // Re-emitting the same id (plan/thinking snapshots) refreshes `input`
    // without appending a second part.
    let mut acc = PartsAccumulator::default();
    acc.tool_input(
        "plan",
        "TodoWrite",
        &serde_json::json!({ "todos": [1] }),
        false,
        None,
    );
    acc.tool_input(
        "plan",
        "TodoWrite",
        &serde_json::json!({ "todos": [1, 2] }),
        false,
        None,
    );
    assert_eq!(acc.parts.len(), 1);
    assert_eq!(
        acc.parts[0]["input"],
        serde_json::json!({ "todos": [1, 2] })
    );
}

#[test]
fn parts_tool_output_patches_matching_input_part() {
    let mut acc = PartsAccumulator::default();
    acc.tool_input("call-a", "search", &serde_json::json!({}), false, None);
    acc.tool_output("call-a", &serde_json::json!({ "hits": 3 }), false, None);
    assert_eq!(acc.parts[0]["state"], serde_json::json!("output-available"));
    assert_eq!(acc.parts[0]["output"], serde_json::json!({ "hits": 3 }));

    // An error output flips the state to `output-error`.
    acc.tool_input("call-b", "run", &serde_json::json!({}), false, None);
    acc.tool_output("call-b", &serde_json::json!("boom"), true, None);
    assert_eq!(acc.parts[1]["state"], serde_json::json!("output-error"));
}

#[test]
fn parts_tool_output_without_matching_input_is_dropped() {
    // A bare output frame with no opened input part is not renderable and must
    // be dropped (no phantom part appears).
    let mut acc = PartsAccumulator::default();
    acc.tool_output("orphan", &serde_json::json!({ "x": 1 }), false, None);
    assert!(acc.is_empty(), "orphan output must not create a part");
}

#[test]
fn acp_config_options_part_matches_the_name_the_desktop_reads() {
    // A CROSS-UNIT contract no compiler checks: Core names the part and the
    // desktop matches that string literally
    // (`part.type !== "data-ryu-acp-config-options"` in ChatPage). Renaming
    // either side alone makes the composer's pickers quietly stop refreshing
    // — no error, no failing build.
    let options = serde_json::json!([
        { "id": "effort", "name": "Reasoning effort", "value": "high" }
    ]);
    let frame = decode_frame(ui_data(
        "ryu-acp-config-options",
        &serde_json::json!({ "configOptions": options }),
    ));
    assert_eq!(
        frame["type"],
        serde_json::json!("data-ryu-acp-config-options")
    );
    assert_eq!(
        frame["data"]["configOptions"][0]["id"],
        serde_json::json!("effort")
    );
}
