//! Thumbs feedback fan-out: snippet truncation and the provenance of the
//! memory a vote records.

use super::*;

use crate::server::conversations::Tenancy;

#[test]
fn truncate_snippet_trims_and_leaves_short_text_unchanged() {
    assert_eq!(truncate_snippet("  hello  ", 10), "hello");
    // Exactly `max` chars is not truncated (no ellipsis).
    assert_eq!(truncate_snippet("abcde", 5), "abcde");
}

#[test]
fn truncate_snippet_cuts_long_text_and_appends_ellipsis() {
    let out = truncate_snippet("abcdefghij", 3);
    assert_eq!(out, "abc…");
    // The ellipsis is a single char, not three dots.
    assert_eq!(out.chars().count(), 4);
}

#[test]
fn truncate_snippet_counts_chars_not_bytes_for_multibyte() {
    // Four multibyte codepoints; max=2 keeps two whole chars + ellipsis.
    let out = truncate_snippet("héllo wörld ☃☃", 2);
    assert_eq!(out, "hé…");
    // Never splits a multibyte codepoint (would panic on a byte boundary).
    assert!(out.chars().count() == 3);
}

#[test]
fn truncate_snippet_zero_max_is_just_ellipsis_for_nonempty() {
    assert_eq!(truncate_snippet("x", 0), "…");
    // Empty (after trim) stays empty even at max 0.
    assert_eq!(truncate_snippet("   ", 0), "");
}

fn state(directory: &std::path::Path) -> ServerState {
    crate::server::isolated_plugin_hook_test_state(directory)
}

/// Append a (user, assistant) turn to `c1` and return the assistant message id.
async fn rated_turn(state: &ServerState) -> String {
    for (role, content) in [
        ("user", "Which seat should I book?"),
        ("assistant", "Book a window seat, as you prefer."),
    ] {
        let id = state
            .conversations
            .append_message_as("c1", role, content, None, None, None, Tenancy::Unattributed)
            .await
            .unwrap();
        if role == "assistant" {
            return id;
        }
    }
    unreachable!("the turn always ends with an assistant message")
}

/// The single feedback memory recorded for `message_id`.
async fn feedback_memory(state: &ServerState, message_id: &str) -> memory::LongTermEntry {
    let ids = state
        .memory
        .ids_with_tag(&format!("msg:{message_id}"))
        .await
        .unwrap();
    assert_eq!(
        ids.len(),
        1,
        "exactly one feedback memory per rated message"
    );
    state.memory.get(&ids[0]).await.unwrap().unwrap()
}

#[tokio::test]
async fn thumbs_up_memory_records_feedback_provenance_with_turn_ids() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let message_id = rated_turn(&state).await;

    let outcome = apply_message_feedback(&state, "c1", &message_id, Some("up"), None).await;

    assert!(outcome.memory_captured);
    let entry = feedback_memory(&state, &message_id).await;
    assert_eq!(entry.provenance.source, memory::MemorySource::Feedback);
    assert_eq!(entry.provenance.conversation_id.as_deref(), Some("c1"));
    assert_eq!(entry.provenance.message_ids, vec![message_id.clone()]);
    assert_eq!(entry.lifecycle, memory::MemoryLifecycle::Active);
    assert!(entry.tags.iter().any(|tag| tag == "good-answer"));
    assert!(entry.content.contains("Book a window seat"));
}

#[tokio::test]
async fn changed_vote_replaces_the_memory_and_keeps_feedback_provenance() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let message_id = rated_turn(&state).await;

    apply_message_feedback(&state, "c1", &message_id, Some("up"), None).await;
    let outcome = apply_message_feedback(&state, "c1", &message_id, Some("down"), None).await;

    assert!(outcome.memory_captured);
    let entry = feedback_memory(&state, &message_id).await;
    assert!(entry.tags.iter().any(|tag| tag == "avoid"));
    assert_eq!(entry.provenance.source, memory::MemorySource::Feedback);
    assert_eq!(entry.provenance.conversation_id.as_deref(), Some("c1"));
    assert_eq!(entry.provenance.message_ids, vec![message_id.clone()]);

    apply_message_feedback(&state, "c1", &message_id, None, None).await;
    let left = state
        .memory
        .ids_with_tag(&format!("msg:{message_id}"))
        .await
        .unwrap();
    assert!(left.is_empty(), "a cleared vote removes its memory");
}

#[test]
fn feedback_metadata_cites_the_conversation_and_rated_message() {
    let metadata = feedback_memory_metadata("c1", "m-9");
    assert_eq!(metadata.provenance.source, memory::MemorySource::Feedback);
    assert_eq!(metadata.provenance.conversation_id.as_deref(), Some("c1"));
    assert_eq!(metadata.provenance.message_ids, vec!["m-9".to_owned()]);
    assert_eq!(metadata.lifecycle, memory::MemoryLifecycle::Active);
}
