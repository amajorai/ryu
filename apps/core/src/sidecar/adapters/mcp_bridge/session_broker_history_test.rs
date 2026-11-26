//! The in-process broker bridge refuses `propose` after a private device read
//! that is only in the conversation's stored history (no live device turn).

use super::tests::{failed, mint, text, unique, vault};
use super::*;
use crate::vault::broker::proposals;

/// A bridge for `conversation` whose registry reads `store`'s history.
async fn bridge_with_history(
    conversation: &str,
    token: &str,
    store: crate::server::conversations::ConversationStore,
) -> BrokeredHandler {
    let mut registry = McpRegistry::empty();
    registry.conversations = Some(store);
    let server = build_ryu_mcp_server(
        Arc::new(registry),
        None,
        Vec::new(),
        "ryu".to_owned(),
        Vec::new(),
        None,
        None,
        None,
        Some(conversation.to_owned()),
    )
    .await
    .unwrap()
    .with_broker_session(Some(token));
    let credentials = server.broker_credentials.clone().unwrap();
    BrokeredHandler::new(server.new_handler(), credentials)
}

#[tokio::test]
async fn a_device_read_in_an_earlier_turn_blocks_a_proposal_with_no_live_turn() {
    use crate::server::conversations::{ConversationStore, Tenancy};
    let (token, session_id) = mint().await;
    let store = ConversationStore::open_in_memory().unwrap();
    let conversation = unique("conv-");
    // An earlier turn read the phone's location; this turn has no device
    // offer at all (the phone is not part of it).
    let read = json!([{
        "type": "tool-device_location_current", "toolCallId": "t",
        "state": "output-available", "output": { "lat": 37.33, "lon": -122.03 }
    }]);
    store
        .append_message_as_with_render_data(
            &conversation,
            "assistant",
            "",
            None,
            None,
            None,
            Tenancy::Unattributed,
            None,
            None,
            Some(&read),
            None,
        )
        .await
        .unwrap();
    let handler = bridge_with_history(&conversation, &token, store.clone()).await;
    assert!(handler.device_offer().is_none());

    let refused = handler
        .broker_call(
            hosted_mcp::PROPOSE,
            json!({ "message": "37.33,-122.03" }),
            None,
        )
        .await
        .unwrap();
    assert!(failed(&refused));
    assert!(
        text(&refused).contains("device.location.current"),
        "{}",
        text(&refused)
    );
    let filed = {
        let conn = vault().conn.lock().await;
        proposals::list(&conn, None).unwrap()
    };
    let subject = format!("broker_session:{session_id}");
    assert!(filed
        .iter()
        .all(|proposal| proposal.requested_by != subject));

    // A conversation with no device read in its history still files.
    let (clean_token, clean_session) = mint().await;
    let clean = bridge_with_history(&unique("conv-"), &clean_token, store).await;
    let filed = clean
        .broker_call(
            hosted_mcp::PROPOSE,
            json!({ "message": "need the Linear token",
                    "credentials": [{ "ref": format!("secret:{}", unique("HIST_")) }] }),
            None,
        )
        .await
        .unwrap();
    assert!(!failed(&filed), "{}", text(&filed));
    let listed = {
        let conn = vault().conn.lock().await;
        proposals::list(&conn, None).unwrap()
    };
    let clean_subject = format!("broker_session:{clean_session}");
    assert!(listed
        .iter()
        .any(|proposal| proposal.requested_by == clean_subject));
}

#[tokio::test]
async fn a_history_part_that_cannot_be_read_refuses_a_proposal() {
    use crate::server::conversations::{ConversationStore, Tenancy};
    let (token, session_id) = mint().await;
    let store = ConversationStore::open_in_memory().unwrap();
    let conversation = unique("conv-");
    let parts = json!([{ "type": "text", "text": "hello" }]);
    store
        .append_message_as_with_render_data(
            &conversation,
            "assistant",
            "hello",
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
    // A part the guard cannot decrypt could hold a device read: it cannot be
    // vouched for, so the proposal is refused.
    store.corrupt_parts_for_test(&conversation).await;
    let handler = bridge_with_history(&conversation, &token, store).await;
    let refused = handler
        .broker_call(hosted_mcp::PROPOSE, json!({ "message": "x" }), None)
        .await
        .unwrap();
    assert!(failed(&refused));
    assert!(
        text(&refused).contains("could not be checked"),
        "{}",
        text(&refused)
    );
    let filed = {
        let conn = vault().conn.lock().await;
        proposals::list(&conn, None).unwrap()
    };
    let subject = format!("broker_session:{session_id}");
    assert!(filed
        .iter()
        .all(|proposal| proposal.requested_by != subject));
}

#[tokio::test]
async fn a_read_in_an_ended_turn_not_yet_stored_refuses_a_proposal() {
    let (token, session_id) = mint().await;
    let conversation = unique("conv-");
    let decl = serde_json::from_value(json!({
        "device_id": uuid::Uuid::new_v4().to_string(), "app": "ryu-bot", "platform": "ios",
        "foreground": true, "catalog_version": 1, "tools": [{ "app": "contacts", "permission": "granted" }],
    }))
    .unwrap();
    let offer = Arc::new(crate::device_tools::DeviceOffer::new(
        conversation.clone(),
        crate::device_tools::identity::DevicePrincipal::LocalOwner,
        decl,
        crate::approvals::policy::ApprovalMode::Smart,
    ));
    let (instance, _rx) = tokio::sync::mpsc::unbounded_channel();
    let turn =
        crate::device_tools::offer::register_turn_context(Arc::clone(&offer), &instance, "ryu");
    crate::device_tools::taint::mark_device_read(&offer, "device.contacts.search");
    // The turn ends before its parts reach the (empty) stored history.
    drop(turn);
    let store = crate::server::conversations::ConversationStore::open_in_memory().unwrap();
    let handler = bridge_with_history(&conversation, &token, store).await;
    assert!(handler.device_offer().is_none());
    let refused = handler
        .broker_call(hosted_mcp::PROPOSE, json!({ "message": "x" }), None)
        .await
        .unwrap();
    assert!(failed(&refused));
    assert!(
        text(&refused).contains("device.contacts.search"),
        "{}",
        text(&refused)
    );
    let filed = {
        let conn = vault().conn.lock().await;
        proposals::list(&conn, None).unwrap()
    };
    let subject = format!("broker_session:{session_id}");
    assert!(filed
        .iter()
        .all(|proposal| proposal.requested_by != subject));
}
