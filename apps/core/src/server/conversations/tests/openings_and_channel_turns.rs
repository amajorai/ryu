//! Conversation store tests: openings and channel turns.

use super::*;

/// UNBOUND PARITY: on a personal node nothing changes. Rows stay NULL-tenanted and
/// every one of them stays visible — no offline lockout, byte-identical to the
/// pre-ACL build.
#[tokio::test]
async fn an_unbound_personal_node_is_unchanged_on_every_creation_path() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("u1", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .append_message_as("u2", "user", "hi", None, None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .append_message_with_id("u3", "m1", "user", "hi", None, 1, Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .add_participant("u4", "agent-a", Tenancy::Unattributed)
        .await
        .unwrap();
    let session = store
        .create_session(
            "agent-a",
            RunnableKind::Agent,
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let forked = store
        .fork_conversation("u2", None, Tenancy::Unattributed)
        .await
        .unwrap()
        .expect("fork");

    for id in ["u1", "u2", "u3", "u4"] {
        let meta = store.get_access_meta(id).await.unwrap().unwrap();
        assert_eq!(
            meta.owner_user_id, None,
            "an unbound node must not stamp tenancy on {id}"
        );
        assert_eq!(meta.org_id, None);
    }

    // node_bound = false ⇒ NO filtering at all: every row is visible, exactly as
    // before the ACL existed.
    let visible = store
        .visible_conversation_ids(None, None, false)
        .await
        .unwrap();
    for id in ["u1", "u2", "u3", "u4", &session.conversation_id, &forked.id] {
        assert!(
            visible.iter().any(|v| v == id),
            "unbound node lost visibility of {id} — this is the offline-lockout regression"
        );
    }
    assert_eq!(store.list_conversations().await.unwrap().len(), 6);
}

#[tokio::test]
async fn proactive_opening_claim_is_exactly_once_until_completed() {
    let store = ConversationStore::open_in_memory().unwrap();

    assert!(store
        .claim_proactive_opening("opening-1", "conversation-1")
        .await
        .unwrap());
    assert!(!store
        .claim_proactive_opening("opening-1", "conversation-1")
        .await
        .unwrap());
    assert_eq!(
        store.proactive_opening_status("opening-1").await.unwrap(),
        Some(ProactiveOpeningStatus {
            conversation_id: "conversation-1".to_string(),
            status: "running".to_string(),
        })
    );

    store.complete_proactive_opening("opening-1").await.unwrap();
    assert_eq!(
        store.proactive_opening_status("opening-1").await.unwrap(),
        Some(ProactiveOpeningStatus {
            conversation_id: "conversation-1".to_string(),
            status: "completed".to_string(),
        })
    );
    assert!(!store
        .claim_proactive_opening("opening-1", "conversation-1")
        .await
        .unwrap());
    assert!(!store
        .claim_proactive_opening("opening-1", "conversation-2")
        .await
        .unwrap());
}

#[tokio::test]
async fn failed_proactive_opening_can_be_released_for_a_readiness_retry() {
    let store = ConversationStore::open_in_memory().unwrap();

    assert!(store
        .claim_proactive_opening("opening-2", "conversation-2")
        .await
        .unwrap());
    store.release_proactive_opening("opening-2").await.unwrap();
    assert_eq!(
        store.proactive_opening_status("opening-2").await.unwrap(),
        None
    );
    assert!(store
        .claim_proactive_opening("opening-2", "conversation-2")
        .await
        .unwrap());
}

#[tokio::test]
async fn channel_turn_idempotency_replays_the_completed_result() {
    let store = ConversationStore::open_in_memory().unwrap();
    assert_eq!(
        store
            .claim_channel_turn("telegram:bot-a:update-42", "conversation-1", "hash-1")
            .await
            .unwrap(),
        ChannelTurnClaim::Claimed
    );
    assert_eq!(
        store
            .claim_channel_turn("telegram:bot-a:update-42", "conversation-1", "hash-1")
            .await
            .unwrap(),
        ChannelTurnClaim::InFlight
    );

    let result = ChannelTurnReplay {
        reply: "same reply".to_string(),
        assistant_message_id: Some("assistant-1".to_string()),
        assistant_message_ids: vec!["assistant-1".to_string(), "assistant-2".to_string()],
        agent_id: Some("agent-1".to_string()),
        fallback_warning: None,
        interactive_markup: Some(ryu_channel_contracts::InteractiveMarkup {
            layout: ryu_channel_contracts::InteractiveLayout::Inline,
            rows: vec![vec![ryu_channel_contracts::InteractiveButton {
                label: "Approve".to_owned(),
                action: ryu_channel_contracts::InteractiveAction::Callback {
                    action_id: "review.approve".to_owned(),
                    payload: serde_json::json!({ "requestId": "7" }),
                },
            }]],
        }),
    };
    store
        .complete_channel_turn("telegram:bot-a:update-42", &result)
        .await
        .unwrap();

    assert_eq!(
        store
            .claim_channel_turn("telegram:bot-a:update-42", "conversation-1", "hash-1")
            .await
            .unwrap(),
        ChannelTurnClaim::Completed(result)
    );
}

#[tokio::test]
async fn channel_turn_idempotency_rejects_key_reuse_for_different_input() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_channel_turn("whatsapp:bot-a:wamid-1", "conversation-1", "hash-1")
        .await
        .unwrap();
    let error = store
        .claim_channel_turn("whatsapp:bot-a:wamid-1", "conversation-1", "hash-2")
        .await
        .expect_err("one provider id must not be reused for another payload");
    assert!(error
        .to_string()
        .contains("idempotency key was reused for a different request"));
}

/// The request object the channel-session route hashes, built in the route's
/// key order (not sorted).
fn channel_turn_request(text: &str) -> serde_json::Value {
    serde_json::json!({
        "conversation_id": "conversation-1",
        "channel_id": "channel-1",
        "agent_id": "agent-1",
        "team_id": null,
        "text": text,
        "author_name": "Ada",
        "channel_action": null,
    })
}

/// Rewrite a claimed row as one written before `hash_scheme` existed: the
/// legacy digest, no scheme, created `age_ms` ago.
async fn make_pre_upgrade_row(store: &ConversationStore, key: &str, digest: &str, age_ms: i64) {
    let conn = store.conn.lock().await;
    let created_at = now_millis() - age_ms;
    conn.execute(
        "UPDATE channel_turn_idempotency
         SET request_hash = ?2, hash_scheme = NULL, created_at = ?3, updated_at = ?3
         WHERE idempotency_key = ?1",
        params![key, digest, created_at],
    )
    .unwrap();
}

fn replay(reply: &str) -> ChannelTurnReplay {
    ChannelTurnReplay {
        reply: reply.to_owned(),
        assistant_message_id: Some("assistant-1".to_owned()),
        assistant_message_ids: vec!["assistant-1".to_owned()],
        agent_id: Some("agent-1".to_owned()),
        fallback_warning: None,
        interactive_markup: None,
    }
}

#[test]
fn legacy_channel_turn_digest_is_the_insertion_order_sha256() {
    use sha2::{Digest, Sha256};
    let request = channel_turn_request("hello");
    let insertion_order = r#"{"conversation_id":"conversation-1","channel_id":"channel-1","agent_id":"agent-1","team_id":null,"text":"hello","author_name":"Ada","channel_action":null}"#;
    assert_eq!(
        legacy_channel_turn_request_hash(&request),
        hex::encode(Sha256::digest(insertion_order.as_bytes()))
    );
    assert_ne!(
        legacy_channel_turn_request_hash(&request),
        ryu_tracing::hash_args(&request)
    );
}

#[tokio::test]
async fn channel_turn_retry_across_the_hash_upgrade_replays_a_pre_upgrade_row() {
    let store = ConversationStore::open_in_memory().unwrap();
    let key = "telegram:bot-a:update-7";
    let request = channel_turn_request("hello");
    let legacy = legacy_channel_turn_request_hash(&request);
    store
        .claim_channel_turn(key, "conversation-1", &legacy)
        .await
        .unwrap();
    store
        .complete_channel_turn(key, &replay("same reply"))
        .await
        .unwrap();
    make_pre_upgrade_row(&store, key, &legacy, 60_000).await;

    // The current digest alone fails closed on the pre-upgrade row.
    let current = ryu_tracing::hash_args(&request);
    assert!(store
        .claim_channel_turn(key, "conversation-1", &current)
        .await
        .is_err());
    assert_eq!(
        store
            .claim_channel_turn_for_request(key, "conversation-1", &request)
            .await
            .unwrap(),
        ChannelTurnClaim::Completed(replay("same reply"))
    );
    // A different payload under the same key is still a reuse.
    let error = store
        .claim_channel_turn_for_request(key, "conversation-1", &channel_turn_request("other"))
        .await
        .expect_err("a different request must not match the legacy row");
    assert!(error
        .to_string()
        .contains("idempotency key was reused for a different request"));
}

#[tokio::test]
async fn legacy_channel_turn_digest_only_matches_pre_upgrade_rows_inside_the_window() {
    let store = ConversationStore::open_in_memory().unwrap();
    let request = channel_turn_request("hello");
    let legacy = legacy_channel_turn_request_hash(&request);

    // A row written with the current scheme never matches a legacy digest.
    store
        .claim_channel_turn("key-current", "conversation-1", &legacy)
        .await
        .unwrap();
    assert!(store
        .claim_channel_turn_for_request("key-current", "conversation-1", &request)
        .await
        .is_err());

    // A pre-upgrade row past the window no longer matches either. It is a
    // stale processing claim, which the retention sweep does not delete.
    store
        .claim_channel_turn("key-expired", "conversation-1", &legacy)
        .await
        .unwrap();
    make_pre_upgrade_row(
        &store,
        "key-expired",
        &legacy,
        LEGACY_CHANNEL_TURN_HASH_WINDOW_MS + 60_000,
    )
    .await;
    assert!(store
        .claim_channel_turn_for_request("key-expired", "conversation-1", &request)
        .await
        .is_err());

    // A stale pre-upgrade claim inside the window is reclaimed and moves to
    // the current digest, so the next retry matches without the legacy one.
    store
        .claim_channel_turn("key-stale", "conversation-1", &legacy)
        .await
        .unwrap();
    make_pre_upgrade_row(&store, "key-stale", &legacy, 20 * 60 * 1000).await;
    assert_eq!(
        store
            .claim_channel_turn_for_request("key-stale", "conversation-1", &request)
            .await
            .unwrap(),
        ChannelTurnClaim::Claimed
    );
    store
        .complete_channel_turn("key-stale", &replay("fresh"))
        .await
        .unwrap();
    assert_eq!(
        store
            .claim_channel_turn(
                "key-stale",
                "conversation-1",
                &ryu_tracing::hash_args(&request)
            )
            .await
            .unwrap(),
        ChannelTurnClaim::Completed(replay("fresh"))
    );
}
