//! Registry keys for document rooms.
//!
//! Conversation, document and application rooms share one in-process
//! [`RoomRegistry`](crate::RoomRegistry). Conversation rooms keep the raw
//! conversation id as their key (many server-side publishers broadcast to it
//! directly), so every other kind must live in a disjoint namespace. Otherwise a
//! caller who owns a conversation whose id equals a Space document id would land
//! in that document's room and receive its live CRDT updates, awareness, resets
//! and presence without passing the document's tenancy check.

/// Prefixes that only namespaced (non-conversation) room keys may start with.
const RESERVED_ROOM_KEY_PREFIXES: [&str; 2] = ["document/", "application/"];

/// Build the registry key for a Space document's collaboration room.
///
/// The `document/` prefix keeps it out of the raw conversation keyspace, and the
/// length prefix keeps it unambiguous. Callers must join and publish document
/// frames through this key; the bare `doc_id` still names the CRDT store entry.
pub fn document_room_key(doc_id: &str) -> String {
    format!("document/{}:{}", doc_id.len(), doc_id)
}

/// Whether a raw (conversation) room id would alias a namespaced document or
/// application room key. Conversation joins with such an id must be refused.
pub fn is_reserved_room_id(room_id: &str) -> bool {
    RESERVED_ROOM_KEY_PREFIXES
        .iter()
        .any(|prefix| room_id.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{application_room_key, Frame, RoomRegistry};
    use tokio::sync::broadcast::error::TryRecvError;

    #[test]
    fn document_keys_are_disjoint_from_raw_and_application_keys() {
        let key = document_room_key("d1");
        assert_ne!(key, "d1");
        assert_ne!(key, application_room_key("a", "d1"));
        assert!(is_reserved_room_id(&key));
        assert!(is_reserved_room_id(&application_room_key("a", "d1")));
        assert!(!is_reserved_room_id("d1"));
        assert!(!is_reserved_room_id("conv-document/x"));
    }

    #[tokio::test]
    async fn document_frames_do_not_reach_a_same_id_conversation_room() {
        let registry = RoomRegistry::new();
        let conversation = registry.join("d1", "m1");
        let document = registry.join(&document_room_key("d1"), "m2");
        let mut conversation_rx = conversation.subscribe();
        let mut document_rx = document.subscribe();

        registry.publish_document_reset("d1", 7);
        document.handle().publish_doc_sync(vec![1, 2, 3]);

        assert!(matches!(
            document_rx.recv().await,
            Ok(Frame::DocumentReset { epoch: 7 })
        ));
        assert!(
            matches!(document_rx.recv().await, Ok(Frame::DocSync(bytes)) if bytes == [1, 2, 3])
        );
        assert!(matches!(
            conversation_rx.try_recv(),
            Err(TryRecvError::Empty)
        ));
        assert_eq!(registry.get_or_create("d1").member_count(), 1);
    }
}
