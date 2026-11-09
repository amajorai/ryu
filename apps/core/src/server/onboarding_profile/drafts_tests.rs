//! The startup sweep of abandoned profile drafts, and the provenance of the
//! profile memory an accepted draft writes.

use super::jobs_tests::test_job;
use super::*;

#[tokio::test]
async fn the_startup_sweep_removes_only_abandoned_profile_drafts() {
    let directory = tempfile::tempdir().expect("temp dir");
    let preferences =
        crate::server::preferences::PreferencesStore::open(directory.path().join("prefs.db"))
            .expect("preferences store");
    let conversations =
        crate::server::conversations::ConversationStore::open_in_memory().expect("store");
    for conversation_id in ["profile-abandoned", "profile-accepted"] {
        mark_pending_profile_draft(&preferences, conversation_id)
            .await
            .expect("marked");
        conversations
            .ensure_conversation(conversation_id, Some("ryu"), None, Tenancy::Unattributed)
            .await
            .expect("conversation");
    }
    // An accepted draft is cleared before it is materialised.
    clear_pending_profile_draft(&preferences, "profile-accepted").await;

    let removed = sweep_abandoned_profile_drafts(&preferences, &conversations).await;

    assert_eq!(removed, 1);
    assert!(conversations
        .get_access_meta("profile-abandoned")
        .await
        .expect("lookup")
        .is_none());
    assert!(conversations
        .get_access_meta("profile-accepted")
        .await
        .expect("lookup")
        .is_some());
    assert!(read_pending_profile_drafts(&preferences).await.is_empty());
    assert_eq!(
        sweep_abandoned_profile_drafts(&preferences, &conversations).await,
        0
    );
}

/// Persist the draft turn (prompt, then the assistant's profile reply) into the
/// profile conversation and return the reply's message id.
async fn persisted_draft_turn(state: &ServerState, conversation_id: &str) -> String {
    let mut reply_id = None;
    for (role, content) in [
        ("user", "Build a private profile of me."),
        ("assistant", "Prefers concise replies."),
    ] {
        let id = state
            .conversations
            .append_message_as(
                conversation_id,
                role,
                content,
                None,
                None,
                None,
                Tenancy::Unattributed,
            )
            .await
            .expect("message");
        if role == "assistant" {
            reply_id = Some(id);
        }
    }
    reply_id.expect("the turn ends with the assistant reply")
}

#[tokio::test]
async fn an_accepted_profile_is_a_conversation_memory_citing_its_draft_reply() {
    let directory = tempfile::tempdir().expect("temp dir");
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let inputs = test_job().inputs;
    let conversation_id = "profile-provenance";
    ensure_profile_conversation(&state, &inputs, conversation_id)
        .await
        .expect("conversation");
    let reply_id = persisted_draft_turn(&state, conversation_id).await;
    let draft = ProfileDraft {
        agent_id: "ryu".to_owned(),
        agent_suggestions: Vec::new(),
        profile: "Prefers concise replies.".to_owned(),
    };

    materialize_profile(&state, &inputs, conversation_id, draft)
        .await
        .expect("materialized");

    let ids = state
        .memory
        .ids_with_tag("profile-bootstrap")
        .await
        .expect("lookup");
    assert_eq!(ids.len(), 1, "one profile memory per accepted draft");
    let entry = state
        .memory
        .get(&ids[0])
        .await
        .expect("read")
        .expect("entry");
    assert_eq!(
        entry.provenance.source,
        crate::server::memory::MemorySource::Conversation
    );
    assert_eq!(
        entry.provenance.conversation_id.as_deref(),
        Some(conversation_id)
    );
    assert_eq!(entry.provenance.message_ids, vec![reply_id]);
    assert!(entry.content.contains("Prefers concise replies."));
}

#[test]
fn profile_provenance_without_a_stored_reply_still_cites_the_conversation() {
    let metadata = profile_memory_metadata("profile-1", &[]);
    assert_eq!(
        metadata.provenance.source,
        crate::server::memory::MemorySource::Conversation
    );
    assert_eq!(
        metadata.provenance.conversation_id.as_deref(),
        Some("profile-1")
    );
    assert!(metadata.provenance.message_ids.is_empty());
    assert_eq!(
        metadata.lifecycle,
        crate::server::memory::MemoryLifecycle::Active
    );
}
