//! Regression tests for realtime room keyspace separation: a conversation room
//! must never alias a Space document (or application) room with the same id.

use super::{room_registry_key, RoomKind};
use ryu_realtime::{Frame, RoomRegistry};
use tokio::sync::broadcast::error::TryRecvError;

#[test]
fn document_and_conversation_with_same_id_get_distinct_keys() {
    let doc = room_registry_key(&RoomKind::Document, None, "d1").unwrap();
    let conversation = room_registry_key(&RoomKind::Conversation, None, "d1").unwrap();
    let application = room_registry_key(&RoomKind::Application, Some("@ryu/app"), "d1").unwrap();
    assert_eq!(conversation, "d1");
    assert_ne!(doc, conversation);
    assert_ne!(doc, application);
    assert_ne!(application, conversation);
}

#[test]
fn conversation_join_cannot_name_a_namespaced_key() {
    let doc_key = room_registry_key(&RoomKind::Document, None, "d1").unwrap();
    let app_key = room_registry_key(&RoomKind::Application, Some("@ryu/app"), "r").unwrap();
    assert_eq!(
        room_registry_key(&RoomKind::Conversation, None, &doc_key),
        Err("reserved-room-id")
    );
    assert_eq!(
        room_registry_key(&RoomKind::Conversation, None, &app_key),
        Err("reserved-room-id")
    );
    assert_eq!(
        room_registry_key(&RoomKind::Application, None, "r"),
        Err("application-app-id-required")
    );
}

#[tokio::test]
async fn document_frames_never_reach_a_same_id_conversation_member() {
    let registry = RoomRegistry::new();
    let doc_key = room_registry_key(&RoomKind::Document, None, "d1").unwrap();
    let conversation_key = room_registry_key(&RoomKind::Conversation, None, "d1").unwrap();
    let document = registry.join(&doc_key, "alice");
    let conversation = registry.join(&conversation_key, "bob");
    let mut bob_rx = conversation.subscribe();
    let mut alice_rx = document.subscribe();

    document.handle().publish_doc_sync(vec![9, 9]);
    registry.publish_document_reset("d1", 3);

    assert!(matches!(alice_rx.recv().await, Ok(Frame::DocSync(bytes)) if bytes == [9, 9]));
    assert!(matches!(
        alice_rx.recv().await,
        Ok(Frame::DocumentReset { epoch: 3 })
    ));
    assert!(matches!(bob_rx.try_recv(), Err(TryRecvError::Empty)));
    assert_eq!(conversation.handle().member_count(), 1);
}
