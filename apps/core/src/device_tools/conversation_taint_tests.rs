//! A conversation's device read outside its own live turn: an ended turn, the
//! stored history, another instance's live turn, and the guards that read it.

use std::sync::Arc;

use serde_json::json;

use super::conversation_taint::{conversation_hold, conversation_private_read, UNCHECKED_HISTORY};
use super::identity::DevicePrincipal;
use super::offer::DeviceOffer;
use super::taint::{agent_egress_hold, mark_device_read, with_device_read_scope};
use super::turn_context::register_turn_context;
use crate::approvals::exfiltration_guard::{current_sandbox_run, held_by, DataFlow};
use crate::server::conversations::{ConversationStore, Tenancy};

fn new_conversation() -> String {
    format!("conv-taint-{}", uuid::Uuid::new_v4().simple())
}

fn offer(conversation: &str) -> Arc<DeviceOffer> {
    let decl = serde_json::from_value(json!({
        "device_id": uuid::Uuid::new_v4().to_string(), "app": "ryu-bot", "platform": "ios",
        "foreground": true, "catalog_version": 1, "tools": [{ "app": "location", "permission": "granted" }],
    }))
    .unwrap();
    Arc::new(DeviceOffer::new(
        conversation.to_owned(),
        DevicePrincipal::LocalOwner,
        decl,
        crate::approvals::policy::ApprovalMode::Smart,
    ))
}

/// A store whose `conversation` holds one assistant message with `parts`.
async fn store_with(conversation: &str, parts: serde_json::Value) -> ConversationStore {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message_as_with_render_data(
            conversation,
            "assistant",
            "",
            None,
            None,
            None,
            Tenancy::Unattributed,
            None,
            None,
            Some(&parts),
            None,
        )
        .await
        .unwrap();
    store
}

fn location_read() -> serde_json::Value {
    json!([{
        "type": "tool-device_location_current", "toolCallId": "t",
        "state": "output-available", "output": { "lat": 37.33, "lon": -122.03 }
    }])
}

/// The private read the current scope carries, as a later call sees it.
async fn scoped_source() -> Option<String> {
    current_sandbox_run().and_then(|run| run.private_read_source().map(str::to_owned))
}

#[tokio::test]
async fn a_read_in_an_ended_turn_is_remembered_before_the_history_holds_it() {
    let conversation = new_conversation();
    let (instance, _rx) = tokio::sync::mpsc::unbounded_channel();
    let turn = offer(&conversation);
    let guard = register_turn_context(Arc::clone(&turn), &instance, "ryu");
    mark_device_read(&turn, "device.location.current");
    drop(guard);
    // No store, and nothing stored: only the ended turn knows.
    assert_eq!(
        conversation_private_read(None, &conversation)
            .await
            .unwrap()
            .as_deref(),
        Some("device.location.current")
    );
    assert_eq!(
        agent_egress_hold(None, &conversation, "fetch")
            .await
            .as_deref(),
        Some("device.location.current")
    );
}

#[tokio::test]
async fn an_ended_turn_without_a_read_leaves_the_conversation_clean() {
    let conversation = new_conversation();
    let (instance, _rx) = tokio::sync::mpsc::unbounded_channel();
    drop(register_turn_context(
        offer(&conversation),
        &instance,
        "ryu",
    ));
    assert_eq!(
        conversation_private_read(None, &conversation)
            .await
            .unwrap(),
        None
    );
    assert_eq!(conversation_private_read(None, "").await.unwrap(), None);
}

#[tokio::test]
async fn another_instances_live_turn_counts() {
    let conversation = new_conversation();
    let (instance, _rx) = tokio::sync::mpsc::unbounded_channel();
    let turn = offer(&conversation);
    let _guard = register_turn_context(Arc::clone(&turn), &instance, "ryu");
    assert_eq!(
        conversation_private_read(None, &conversation)
            .await
            .unwrap(),
        None
    );
    mark_device_read(&turn, "device.contacts.search");
    assert_eq!(
        conversation_private_read(None, &conversation)
            .await
            .unwrap()
            .as_deref(),
        Some("device.contacts.search")
    );
}

#[tokio::test]
async fn the_stored_history_counts_and_an_unreadable_one_holds() {
    let conversation = new_conversation();
    let store = store_with(&conversation, location_read()).await;
    assert_eq!(
        conversation_private_read(Some(&store), &conversation)
            .await
            .unwrap()
            .as_deref(),
        Some("device.location.current")
    );
    let clean = new_conversation();
    let clean_store = store_with(&clean, json!([{ "type": "text", "text": "hi" }])).await;
    assert_eq!(
        conversation_private_read(Some(&clean_store), &clean)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        agent_egress_hold(Some(&clean_store), &clean, "fetch").await,
        None
    );

    clean_store.corrupt_parts_for_test(&clean).await;
    assert!(conversation_private_read(Some(&clean_store), &clean)
        .await
        .is_err());
    assert_eq!(
        conversation_hold(Some(&clean_store), &clean)
            .await
            .as_deref(),
        Some(UNCHECKED_HISTORY)
    );
    assert_eq!(
        agent_egress_hold(Some(&clean_store), &clean, "fetch")
            .await
            .as_deref(),
        Some(UNCHECKED_HISTORY)
    );
    assert_eq!(
        agent_egress_hold(Some(&clean_store), &clean, "read").await,
        None
    );
}

#[tokio::test]
async fn a_history_read_scopes_a_bridge_call_so_its_egress_is_held() {
    let conversation = new_conversation();
    let store = store_with(&conversation, location_read()).await;
    // No live device turn: the history alone puts the call in a private
    // scope, so the guard holds an egress call such as `delegate.fanout`.
    let source = with_device_read_scope(None, Some((Some(&store), &conversation)), async {
        let run = current_sandbox_run().expect("a private-read scope");
        let egress = DataFlow {
            private_source: false,
            egress: true,
        };
        held_by(&run, egress)
    })
    .await;
    assert_eq!(source.as_deref(), Some("device.location.current"));

    let clean = new_conversation();
    let clean_store = store_with(&clean, json!([{ "type": "text", "text": "hi" }])).await;
    let scoped =
        with_device_read_scope(None, Some((Some(&clean_store), &clean)), scoped_source()).await;
    assert_eq!(scoped, None);
    // An unreadable history holds too.
    clean_store.corrupt_parts_for_test(&clean).await;
    let scoped =
        with_device_read_scope(None, Some((Some(&clean_store), &clean)), scoped_source()).await;
    assert_eq!(scoped.as_deref(), Some(UNCHECKED_HISTORY));
    // No conversation: nothing to check.
    assert_eq!(
        with_device_read_scope(None, None, scoped_source()).await,
        None
    );
}

#[tokio::test]
async fn the_turns_own_read_wins_over_the_history() {
    let conversation = new_conversation();
    let turn = offer(&conversation);
    mark_device_read(&turn, "device.calendar.list");
    let store = store_with(&conversation, location_read()).await;
    let scoped = with_device_read_scope(
        Some(&turn),
        Some((Some(&store), &conversation)),
        scoped_source(),
    )
    .await;
    assert_eq!(scoped.as_deref(), Some("device.calendar.list"));
}
