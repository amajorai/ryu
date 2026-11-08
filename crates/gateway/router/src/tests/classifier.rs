use super::*;

// ── Classifier helpers ────────────────────────────────────────────────────

#[test]
fn parse_choice_reads_plain_number() {
    assert_eq!(parse_choice("1", 2), Some(1));
    assert_eq!(parse_choice("2", 2), Some(2));
    assert_eq!(parse_choice("0", 2), Some(0));
}

#[test]
fn parse_choice_tolerates_surrounding_text() {
    assert_eq!(parse_choice("Rule 2 best fits.", 2), Some(2));
    assert_eq!(parse_choice("  1\n", 2), Some(1));
}

#[test]
fn parse_choice_rejects_out_of_range_or_garbage() {
    assert_eq!(parse_choice("5", 2), None);
    assert_eq!(parse_choice("none", 2), None);
    assert_eq!(parse_choice("", 2), None);
}

#[test]
fn build_prompt_enumerates_one_based() {
    let p = build_prompt(&descriptions(), "fix my rust code");
    assert!(p.contains("1. coding"));
    assert!(p.contains("2. chit-chat"));
    assert!(p.contains("fix my rust code"));
}

#[test]
fn keyword_match_finds_significant_word() {
    assert_eq!(
        keyword_match(&descriptions(), "help me with coding please"),
        Some(0)
    );
    assert_eq!(
        keyword_match(&descriptions(), "nothing relevant here"),
        None
    );
}

#[test]
fn last_user_message_picks_latest_string() {
    let msgs = json!([
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "reply"},
        {"role": "user", "content": "second"}
    ]);
    assert_eq!(last_user_message(&msgs).as_deref(), Some("second"));
}

#[test]
fn last_user_message_joins_multimodal_parts() {
    let msgs = json!([
        {"role": "user", "content": [
            {"type": "text", "text": "describe"},
            {"type": "image_url", "image_url": {"url": "data:..."}},
            {"type": "text", "text": "this"}
        ]}
    ]);
    assert_eq!(last_user_message(&msgs).as_deref(), Some("describe this"));
}

#[test]
fn weighted_index_respects_relative_weights_and_ignores_invalid_values() {
    assert_eq!(weighted_index(&[1.0, 0.0, f32::NAN, -1.0], 0), Some(0));
    assert_eq!(weighted_index(&[1.0, 3.0], 0), Some(0));
    assert_eq!(weighted_index(&[1.0, 3.0], u64::MAX), Some(1));
    assert_eq!(weighted_index(&[0.0, f32::INFINITY], 42), None);
}

#[test]
fn stage_target_uses_errors_and_progress_with_a_default_for_ambiguous_history() {
    let error_history = json!([
        {"role": "tool", "content": "command failed with error"}
    ]);
    assert_eq!(
        stage_target(&error_history, 3, 0.5, false),
        StageTarget::Capable
    );

    let progress_history = json!([
        {"role": "assistant", "content": "applied patch; tests passed"}
    ]);
    assert_eq!(
        stage_target(&progress_history, 3, 0.5, true),
        StageTarget::Efficient
    );

    let ambiguous = json!([{"role": "user", "content": "hello"}]);
    assert_eq!(stage_target(&ambiguous, 3, 0.5, true), StageTarget::Capable);
    assert_eq!(
        stage_target(&ambiguous, 3, 0.5, false),
        StageTarget::Efficient
    );
}

#[test]
fn the_classify_module_exposes_the_same_helpers() {
    assert_eq!(crate::classify::parse_choice("2", 3), Some(2));
    assert_eq!(crate::classify::truncate("abcdef", 3), "abc");
}
