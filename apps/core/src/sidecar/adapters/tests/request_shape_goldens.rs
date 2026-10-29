use super::*;

// ── Request-shape goldens (provider prompt caching) ─────────────────────
//
// Provider prompt caches key on a byte-identical request PREFIX. These pin the
// assembly rules that keep it stable, on the pure helpers the turn uses:
// stable system layers first, the volatile summary last, per-turn context on
// the newest user message only.

/// The stable system block the flagship agent sends (platform contract, then
/// the user's layers, then the docs hint), assembled with the same merge order
/// as `route_chat_stream_inner`.
fn golden_stable_system() -> Option<String> {
    let user_layers = merge_system_prompt(
        Some("Remembered: the user prefers metric units.".to_owned()),
        Some("You are a calm, concise assistant.".to_owned()),
    );
    let with_docs = merge_system_prompt(ryu_docs_hint_when(false), user_layers);
    let contract =
        crate::ryu_platform::operating_contract(Some("ryu"), false, RyuResponseMode::Everyday);
    merge_system_prompt(contract, with_docs)
}

/// One outbound OpenAI-compat message list: system block, the persisted
/// history, then the newest user turn carrying this turn's ephemeral context.
fn golden_turn(
    system: Option<&str>,
    history: &[(&str, &str)],
    newest: &str,
    context: &str,
) -> Vec<Value> {
    let mut messages = Vec::new();
    if let Some(system) = system {
        messages.push(serde_json::json!({ "role": "system", "content": system }));
    }
    for (role, content) in history {
        messages.push(serde_json::json!({ "role": role, "content": content }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": newest }));
    append_ephemeral_turn_context(&mut messages, context);
    messages
}

fn bytes_of(message: &Value) -> String {
    serde_json::to_string(message).expect("message serializes")
}

#[test]
fn golden_history_before_the_newest_user_turn_is_byte_stable_across_turns() {
    let system = golden_stable_system();
    let turn_n = golden_turn(
        system.as_deref(),
        &[
            ("user", "Plan a weekend in Lisbon."),
            ("assistant", "Day one: Alfama."),
        ],
        "What about day two?",
        "[Turn context]\nLocal time: Saturday 09:00",
    );
    let turn_n_plus_1 = golden_turn(
        system.as_deref(),
        &[
            ("user", "Plan a weekend in Lisbon."),
            ("assistant", "Day one: Alfama."),
            ("user", "What about day two?"),
            ("assistant", "Day two: Belém."),
        ],
        "And dinner?",
        "[Turn context]\nLocal time: Saturday 09:05",
    );
    // Everything before turn N's newest user message is re-sent unchanged.
    let stable = turn_n.len() - 1;
    for index in 0..stable {
        assert_eq!(
            bytes_of(&turn_n[index]),
            bytes_of(&turn_n_plus_1[index]),
            "message {index}"
        );
    }
    // The ephemeral context rode only on the newest turn: turn N's user text is
    // persisted (and re-sent at N+1) without it.
    assert!(bytes_of(&turn_n[stable]).contains("Local time: Saturday 09:00"));
    assert_eq!(turn_n_plus_1[stable]["content"], "What about day two?");
    assert!(bytes_of(turn_n_plus_1.last().unwrap()).contains("Local time: Saturday 09:05"));
}

#[test]
fn golden_system_prefix_survives_a_changed_compaction_summary() {
    let stable = golden_stable_system().expect("flagship system block");
    let first = append_system_suffix(
        Some(stable.clone()),
        Some("[Earlier conversation summary]\n- planned day one".to_owned()),
    )
    .unwrap();
    let second = append_system_suffix(
        Some(stable.clone()),
        Some("[Earlier conversation summary]\n- planned days one and two".to_owned()),
    )
    .unwrap();
    let prefix = format!("{stable}\n\n[Earlier conversation summary]\n- planned day");
    assert!(first.starts_with(&prefix));
    assert!(second.starts_with(&prefix));
    // The label is the summary's own text and is untouched by the placement.
    assert!(first.ends_with("[Earlier conversation summary]\n- planned day one"));
}

#[test]
fn append_system_suffix_puts_the_summary_last_and_is_inert_without_one() {
    let stable = golden_stable_system();
    // No summary: byte-identical to the block assembled before this helper.
    assert_eq!(append_system_suffix(stable.clone(), None), stable);
    assert_eq!(
        append_system_suffix(Some("base".to_owned()), Some(String::new())).as_deref(),
        Some("base")
    );
    assert_eq!(
        append_system_suffix(Some("base".to_owned()), Some("tail".to_owned())).as_deref(),
        Some("base\n\ntail")
    );
    assert_eq!(
        append_system_suffix(Some(String::new()), Some("tail".to_owned())).as_deref(),
        Some("tail")
    );
    assert_eq!(
        append_system_suffix(None, Some("tail".to_owned())).as_deref(),
        Some("tail")
    );
    assert_eq!(append_system_suffix(None, None), None);
}

/// Byte budget for the static system layers the stock flagship agent always
/// carries (operating contract + self-operation guide + docs hint). Every
/// turn pays for these before the user says anything. Set ~10% above the size
/// when last measured (Everyday: 9,543 bytes, the larger of the two modes;
/// Developer: 7,221 — both grew 196 bytes for the batch-independent-reads
/// sentence that pairs with the Gateway's concurrent read-only tool calls);
/// raising it is a deliberate decision — trim first, and bump only with a
/// reason in the change that grows a layer.
const STATIC_SYSTEM_LAYER_BUDGET_BYTES: usize = 10_300;

#[test]
fn golden_static_system_layers_stay_within_their_byte_budget() {
    for mode in [RyuResponseMode::Everyday, RyuResponseMode::Developer] {
        let contract = crate::ryu_platform::operating_contract(Some("ryu"), false, mode)
            .expect("flagship contract");
        let static_layers =
            merge_system_prompt(ryu_docs_hint_when(false), Some(contract)).expect("static layers");
        assert!(
            static_layers.len() <= STATIC_SYSTEM_LAYER_BUDGET_BYTES,
            "{mode:?} static system layers are {} bytes, over the {} byte budget",
            static_layers.len(),
            STATIC_SYSTEM_LAYER_BUDGET_BYTES
        );
    }
}
