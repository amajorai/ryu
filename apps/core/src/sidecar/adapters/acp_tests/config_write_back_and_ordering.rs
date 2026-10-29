use super::*;

// ── Session-config write-back (`details.ryuConfig`) ────────────────────
//
// The agent→client direction of the session-config channel: a tool result
// stamps `details.ryuConfig = { configId: valueId }` and pi-acp preserves it
// as ACP `rawOutput`. Structural twin of `pi_widget_binding` (Completed-gated,
// marker-keyed); these cover the extraction only, the `data-ryu-acp-config`
// part is emitted in mod.rs.

fn ryu_config_raw_output(config: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "content": [{ "type": "text", "text": "done" }],
        "details": { "exited": true, "ryuConfig": config }
    })
}

#[test]
fn pi_config_updates_extracts_only_on_completed_with_marker() {
    let raw = ryu_config_raw_output(serde_json::json!({ "ryu.plan": "off" }));

    // Completed + marker → the requested pairs, verbatim.
    let got = pi_config_updates(Some(&ToolCallStatus::Completed), Some(&raw))
        .expect("completed + marker extracts a config write-back");
    assert_eq!(got.len(), 1);
    assert_eq!(got.get("ryu.plan").map(String::as_str), Some("off"));

    // In-progress (a partial `tool_execution_update`) must NOT extract — a
    // write-back is a one-shot instruction, and acting on a partial frame
    // would flip the user's picker before the tool could still fail.
    assert!(pi_config_updates(Some(&ToolCallStatus::InProgress), Some(&raw)).is_none());
    // Missing status → none.
    assert!(pi_config_updates(None, Some(&raw)).is_none());
}

#[test]
fn pi_config_updates_none_without_marker_or_wrong_shape() {
    // An ordinary tool result (no `details.ryuConfig`) must not write back.
    let plain = serde_json::json!({ "content": [{ "type": "text", "text": "hi" }] });
    assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&plain)).is_none());
    // The sibling markers are different seams and must not be mistaken for this
    // one (mirrors `pi_subagent_steps_none_without_marker_or_wrong_shape`).
    let widget = ryu_widget_raw_output("checklist.render", serde_json::json!({}));
    assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&widget)).is_none());
    let steps = ryu_steps_raw_output("done", serde_json::json!([]));
    assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&steps)).is_none());
    // Marker present but not an object → none (never mint a pair from a scalar).
    let scalar = ryu_config_raw_output(serde_json::json!("off"));
    assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&scalar)).is_none());
    // An empty object yields no usable pair → none, so no empty event is emitted.
    let empty = ryu_config_raw_output(serde_json::json!({}));
    assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&empty)).is_none());
    // No raw_output at all → none.
    assert!(pi_config_updates(Some(&ToolCallStatus::Completed), None).is_none());
}

#[test]
fn pi_config_updates_drops_non_string_values_and_keeps_the_rest() {
    // A `valueId` is a string by ACP's own typing. A malformed entry is dropped
    // per key rather than voiding a marker that also carries usable pairs; a
    // marker with NOTHING usable left degrades to `None`.
    let mixed = ryu_config_raw_output(serde_json::json!({
        "ryu.plan": "off",
        "thought_level": 3,
        "nested": { "a": "b" },
    }));
    let got = pi_config_updates(Some(&ToolCallStatus::Completed), Some(&mixed))
        .expect("the one well-formed pair survives");
    assert_eq!(got.len(), 1);
    assert_eq!(got.get("ryu.plan").map(String::as_str), Some("off"));

    let all_bad = ryu_config_raw_output(serde_json::json!({ "thought_level": 3 }));
    assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&all_bad)).is_none());
}

#[test]
fn pi_config_updates_is_value_agnostic_and_not_pi_specific() {
    // The extractor compiles in no vocabulary of its own: an arbitrary agent's
    // arbitrary option/value round-trips untouched. If this ever needs to know
    // an id or a value, the channel has stopped being agent-neutral.
    let raw = ryu_config_raw_output(serde_json::json!({
        "some.other.agent/option": "whatever-value",
    }));
    let got = pi_config_updates(Some(&ToolCallStatus::Completed), Some(&raw))
        .expect("any producer's ids extract");
    assert_eq!(
        got.get("some.other.agent/option").map(String::as_str),
        Some("whatever-value")
    );
}

#[test]
fn pi_subagent_answer_concatenates_text_blocks() {
    // The `<parent>:out` TaskOutput text comes from the result envelope's
    // `content`, NOT from a second `details.*` marker a producer might forget.
    let raw = ryu_steps_raw_output("", serde_json::json!([]));
    assert!(
        pi_subagent_answer(Some(&raw)).is_none(),
        "empty text → no row"
    );

    let multi = serde_json::json!({
        "content": [
            { "type": "text", "text": "part one " },
            { "type": "image", "data": "…" },
            { "type": "text", "text": "part two" },
        ],
        "details": { "ryuSteps": [] }
    });
    assert_eq!(
        pi_subagent_answer(Some(&multi)).as_deref(),
        Some("part one part two"),
    );
    // No `content` key, and no raw output at all → none.
    assert!(pi_subagent_answer(Some(&serde_json::json!({ "details": {} }))).is_none());
    assert!(pi_subagent_answer(None).is_none());
}

// ── Model-first config-option ordering ───────────────────────────────────
//
// Config options are not independent: opencode 1.18.5 validates its `effort`
// values against the CURRENT model's effort levels. Captured from the real
// binary over ACP:
//
//   effort→model : set_config_option(effort,"high") ⇒
//                  "Invalid params: effort not found: high"; the later model
//                  write then reports effort back as "low" (the pick is lost)
//   model→effort : both succeed, effort reads back "high"
//
// The values arrive as a `HashMap` from the request body, so with no explicit
// order the failing one is whatever the process's randomized hashing yields.

#[test]
fn model_first_applies_the_model_before_every_other_option() {
    let pairs = vec![
        ("effort".to_owned(), "high".to_owned()),
        ("mode".to_owned(), "plan".to_owned()),
        (MODEL_CONFIG_OPTION_ID.to_owned(), "xai/grok-4.6".to_owned()),
    ];
    let ordered: Vec<&str> = model_first(pairs.iter().map(|(a, b)| (a, b)))
        .into_iter()
        .map(|(id, _)| id.as_str())
        .collect();
    assert_eq!(ordered, vec![MODEL_CONFIG_OPTION_ID, "effort", "mode"]);
}

#[test]
fn model_first_is_stable_for_everything_else() {
    // Only the model moves; the rest keep the order they were given, so an
    // agent that cares about its own option order still sees it.
    let pairs = vec![
        ("b".to_owned(), "1".to_owned()),
        ("a".to_owned(), "2".to_owned()),
        ("c".to_owned(), "3".to_owned()),
    ];
    let ordered: Vec<&str> = model_first(pairs.iter().map(|(a, b)| (a, b)))
        .into_iter()
        .map(|(id, _)| id.as_str())
        .collect();
    assert_eq!(ordered, vec!["b", "a", "c"]);
}

#[test]
fn model_first_drops_core_synthesized_and_empty_ids() {
    // `ryu.plan` is applied as a prompt sentinel, never sent to the agent —
    // both the probe and the turn path get that filtering from one place.
    let pairs = vec![
        (PLAN_MODE_CONFIG_ID.to_owned(), PLAN_MODE_ON.to_owned()),
        (String::new(), "ignored".to_owned()),
        ("effort".to_owned(), "high".to_owned()),
    ];
    let ordered: Vec<&str> = model_first(pairs.iter().map(|(a, b)| (a, b)))
        .into_iter()
        .map(|(id, _)| id.as_str())
        .collect();
    assert_eq!(ordered, vec!["effort"]);
}

/// End-to-end against a REAL agent, through Core's own probe path.
///
/// Opt-in (`--ignored`) and env-gated because it spawns a third-party binary
/// and reads that installation's authenticated model list — neither belongs
/// in the default suite. Run it as:
///
/// ```text
/// RYU_TEST_ACP_CMD="$HOME/.opencode/bin/opencode acp" \
/// RYU_TEST_ACP_REASONING_MODEL="xai/grok-4.6" \
///   cargo test -p ryu-core --bin ryu-core probe_with_a_model_selection -- --ignored --nocapture
/// ```
///
/// What it pins is the entire point of `probe_acp_config_with`: the plain
/// probe reports the agent's default option set, and the SAME binary reports
/// a reasoning option once the model that has one is applied first.
#[tokio::test]
#[ignore = "spawns a real third-party agent binary; set RYU_TEST_ACP_CMD to run"]
async fn probe_with_a_model_selection_reveals_that_models_options() {
    let Ok(spawn_cmd) = std::env::var("RYU_TEST_ACP_CMD") else {
        eprintln!("RYU_TEST_ACP_CMD unset — nothing to probe");
        return;
    };
    let model = std::env::var("RYU_TEST_ACP_REASONING_MODEL")
        .expect("RYU_TEST_ACP_REASONING_MODEL must name a model with reasoning levels");
    let cwd = std::env::current_dir().expect("cwd");

    let reasoning_ids = |v: &serde_json::Value| -> Vec<String> {
        v.get("configOptions")
            .and_then(|o| o.as_array())
            .map(|opts| {
                opts.iter()
                    .filter(|o| {
                        let hay = ["category", "id", "name"]
                            .iter()
                            .filter_map(|k| o.get(*k).and_then(|v| v.as_str()))
                            .collect::<Vec<_>>()
                            .join(" ")
                            .to_lowercase();
                        ["thought", "reason", "think", "effort"]
                            .iter()
                            .any(|m| hay.contains(m))
                    })
                    .filter_map(|o| o.get("id").and_then(|v| v.as_str()))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };

    let plain = probe_acp_config_with(spawn_cmd.clone(), cwd.clone(), SessionSelections::new())
        .await
        .expect("plain probe");
    let mut selections = SessionSelections::new();
    selections.insert(MODEL_CONFIG_OPTION_ID.to_owned(), model.clone());
    let selected = probe_acp_config_with(spawn_cmd, cwd, selections)
        .await
        .expect("probe with a model selection");

    eprintln!("plain reasoning options:    {:?}", reasoning_ids(&plain));
    eprintln!("selected reasoning options: {:?}", reasoning_ids(&selected));
    assert!(
        !reasoning_ids(&selected).is_empty(),
        "applying '{model}' must reveal the reasoning option the composer renders"
    );
}
