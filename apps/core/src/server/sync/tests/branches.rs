//! Version tree sync: branched receivers and flat peers.

use super::*;
use crate::server::sync::payloads::sync_links;

// ── Version tree (branched receivers) ────────────────────────────────────

async fn append_turns(
    store: &ConversationStore,
    conv: &str,
    turns: &[(&str, &str)],
) -> Vec<String> {
    let mut ids = Vec::new();
    for (role, text) in turns {
        ids.push(
            store
                .append_message(conv, role, text, None, None, None)
                .await
                .unwrap(),
        );
    }
    ids
}

async fn active_contents(store: &ConversationStore, conv: &str) -> Vec<String> {
    store
        .get_active_messages(conv)
        .await
        .unwrap()
        .into_iter()
        .map(|message| message.content)
        .collect()
}

/// Device A and device B share `u1, a1`, and B has branched (its leaf is set).
async fn shared_history_with_branched_receiver(
    conv: &str,
) -> (ConversationStore, ConversationStore, Vec<String>) {
    let store_a = ConversationStore::open_in_memory().unwrap();
    let store_b = ConversationStore::open_in_memory().unwrap();
    let ids = append_turns(&store_a, conv, &[("user", "u1"), ("assistant", "a1")]).await;
    let payload = build_sync_payload(&store_a, conv).await.unwrap();
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();
    store_b
        .select_version(conv, &ids[1])
        .await
        .unwrap()
        .expect("leaf");
    (store_a, store_b, ids)
}

#[tokio::test]
async fn flat_source_turns_append_to_a_branched_receivers_thread() {
    let conv = "conv-tree-flat-source";
    let (store_a, store_b, _) = shared_history_with_branched_receiver(conv).await;
    let added = append_turns(&store_a, conv, &[("user", "u2"), ("assistant", "a2")]).await;

    let payload = build_sync_payload(&store_a, conv).await.unwrap();
    assert!(
        payload
            .messages
            .iter()
            .all(|m| m.parent_message_id.is_none()),
        "a never-branched source sends no parents"
    );
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();

    assert_eq!(
        active_contents(&store_b, conv).await,
        ["u1", "a1", "u2", "a2"]
    );
    assert_eq!(
        store_b.active_leaf(conv).await.unwrap().as_deref(),
        Some(added[1].as_str())
    );
    let recent = store_b.get_recent_messages(conv, 2).await.unwrap();
    assert_eq!(
        recent
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        ["u2", "a2"],
        "synced turns reach the next turn's model context"
    );
    // Re-applying is idempotent and leaves the tree alone.
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();
    assert_eq!(
        active_contents(&store_b, conv).await,
        ["u1", "a1", "u2", "a2"]
    );
}

#[tokio::test]
async fn branched_source_parents_advance_a_receiver_whose_leaf_they_follow() {
    let conv = "conv-tree-branched-source";
    let (store_a, store_b, ids) = shared_history_with_branched_receiver(conv).await;
    store_a
        .select_version(conv, &ids[1])
        .await
        .unwrap()
        .expect("leaf");
    let added = append_turns(&store_a, conv, &[("user", "u2"), ("assistant", "a2")]).await;

    let payload = build_sync_payload(&store_a, conv).await.unwrap();
    let parents: Vec<Option<&str>> = payload
        .messages
        .iter()
        .map(|m| m.parent_message_id.as_deref())
        .collect();
    assert_eq!(
        parents,
        [
            None,
            Some(ids[0].as_str()),
            Some(ids[1].as_str()),
            Some(added[0].as_str())
        ]
    );
    let roots: Vec<bool> = payload.messages.iter().map(|m| m.version_root).collect();
    assert_eq!(roots, [true, false, false, false]);
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();

    assert_eq!(
        active_contents(&store_b, conv).await,
        ["u1", "a1", "u2", "a2"]
    );
    let stored = store_b.get_messages(conv).await.unwrap();
    assert_eq!(
        stored[2].parent_message_id.as_deref(),
        Some(ids[1].as_str())
    );
    assert_eq!(
        stored[3].parent_message_id.as_deref(),
        Some(added[0].as_str())
    );
}

#[tokio::test]
async fn synced_turns_never_move_the_leaf_off_newer_local_turns() {
    let conv = "conv-tree-local-newer";
    let (store_a, store_b, ids) = shared_history_with_branched_receiver(conv).await;
    // B kept chatting after the shared a1.
    let local = append_turns(&store_b, conv, &[("user", "b-u2"), ("assistant", "b-a2")]).await;
    // A branched too and continued from the same a1.
    store_a
        .select_version(conv, &ids[1])
        .await
        .unwrap()
        .expect("leaf");
    append_turns(&store_a, conv, &[("user", "a-u2"), ("assistant", "a-a2")]).await;

    let payload = build_sync_payload(&store_a, conv).await.unwrap();
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();

    assert_eq!(
        active_contents(&store_b, conv).await,
        ["u1", "a1", "b-u2", "b-a2"]
    );
    assert_eq!(
        store_b.active_leaf(conv).await.unwrap().as_deref(),
        Some(local[1].as_str())
    );
    // A's turns are an alternate version beneath a1, reachable via the pager.
    let active = store_b.get_active_messages(conv).await.unwrap();
    assert_eq!(active[2].sibling_count, 2);
    let synced = active[2]
        .sibling_ids
        .iter()
        .find(|id| **id != local[0])
        .expect("synced sibling")
        .clone();
    store_b.select_version(conv, &synced).await.unwrap();
    assert_eq!(
        active_contents(&store_b, conv).await,
        ["u1", "a1", "a-u2", "a-a2"]
    );
}

#[tokio::test]
async fn flat_receiver_keeps_flat_reads_for_any_peer() {
    let conv = "conv-tree-flat-receiver";
    let store_a = ConversationStore::open_in_memory().unwrap();
    let store_b = ConversationStore::open_in_memory().unwrap();
    let ids = append_turns(&store_a, conv, &[("user", "u1"), ("assistant", "a1")]).await;
    // An older peer's payload: no parents anywhere.
    let payload = build_sync_payload(&store_a, conv).await.unwrap();
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();
    assert_eq!(store_b.active_leaf(conv).await.unwrap(), None);
    assert!(store_b
        .get_messages(conv)
        .await
        .unwrap()
        .iter()
        .all(|m| m.parent_message_id.is_none()));

    // A branched source's parents are not stored: the receiver stays flat,
    // and branching later rebuilds its parents chronologically.
    store_a
        .select_version(conv, &ids[1])
        .await
        .unwrap()
        .expect("leaf");
    append_turns(&store_a, conv, &[("user", "u2")]).await;
    let payload = build_sync_payload(&store_a, conv).await.unwrap();
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();
    assert_eq!(store_b.active_leaf(conv).await.unwrap(), None);
    assert_eq!(active_contents(&store_b, conv).await, ["u1", "a1", "u2"]);
    assert!(store_b
        .get_messages(conv)
        .await
        .unwrap()
        .iter()
        .all(|m| m.parent_message_id.is_none()));
}

#[tokio::test]
async fn merged_payload_keeps_a_flat_peers_turns_on_the_branched_thread() {
    let conv = "conv-tree-merged-relay";
    let (store_a, store_b, ids) = shared_history_with_branched_receiver(conv).await;
    // A branches, continues, and pushes with parents; the relay then merges
    // in u2, a2 that a never-branched device C pushed with none.
    store_a
        .select_version(conv, &ids[1])
        .await
        .unwrap()
        .expect("leaf");
    append_turns(&store_a, conv, &[("user", "a-u2")]).await;
    let mut payload = build_sync_payload(&store_a, conv).await.unwrap();
    assert!(
        payload.messages[0].version_root,
        "a branched source marks its root"
    );
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();
    assert_eq!(active_contents(&store_b, conv).await, ["u1", "a1", "a-u2"]);
    let base = payload.messages.last().unwrap().created_at;
    for (offset, (id, role, text)) in [("c-u2", "user", "u2"), ("c-a2", "assistant", "a2")]
        .into_iter()
        .enumerate()
    {
        payload.messages.push(SyncMessage {
            id: id.to_owned(),
            role: role.to_owned(),
            content: text.to_owned(),
            created_at: base + 1 + offset as i64,
            parent_message_id: None,
            version_root: false,
        });
    }
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();

    assert_eq!(
        active_contents(&store_b, conv).await,
        ["u1", "a1", "a-u2", "u2", "a2"],
        "the flat peer's turns continue the selected version, not new roots"
    );
    let active = store_b.get_active_messages(conv).await.unwrap();
    assert_eq!(active[0].sibling_count, 1, "no extra first-turn versions");
}

#[test]
fn sync_message_parent_is_optional_on_the_wire() {
    let legacy: SyncMessage = serde_json::from_value(serde_json::json!({
        "id": "m1", "role": "user", "content": "hi", "created_at": 1
    }))
    .unwrap();
    assert_eq!(legacy.parent_message_id, None);
    let flat = serde_json::to_value(&legacy).unwrap();
    assert!(
        flat.get("parent_message_id").is_none() && flat.get("version_root").is_none(),
        "flat push is byte-identical"
    );

    let threaded: SyncMessage = serde_json::from_value(serde_json::json!({
        "id": "m2", "role": "assistant", "content": "yo", "created_at": 2,
        "parent_message_id": "m1"
    }))
    .unwrap();
    assert_eq!(threaded.parent_message_id.as_deref(), Some("m1"));
    assert!(!threaded.version_root);

    let root: SyncMessage = serde_json::from_value(serde_json::json!({
        "id": "m0", "role": "user", "content": "hi", "created_at": 0,
        "version_root": true
    }))
    .unwrap();
    assert!(root.version_root);
    assert_eq!(
        serde_json::to_value(&root).unwrap()["version_root"],
        serde_json::json!(true)
    );
}

#[test]
fn sync_links_tell_roots_from_unknown_positions() {
    let message = |id: &str, parent: Option<&str>, version_root: bool| SyncMessage {
        id: id.to_owned(),
        role: "user".to_owned(),
        content: String::new(),
        created_at: 0,
        parent_message_id: parent.map(str::to_owned),
        version_root,
    };
    let flat = sync_links(&[message("a", None, false), message("b", None, false)]);
    assert!(flat.iter().all(|link| link.parent == SyncParent::Unknown));
    let threaded = sync_links(&[
        message("a", None, true),
        message("b", Some("a"), false),
        // A merged payload: another device's flat row is not a root.
        message("c", None, false),
    ]);
    assert_eq!(threaded[0].parent, SyncParent::Root);
    assert_eq!(threaded[1].parent, SyncParent::Message("a".to_owned()));
    assert_eq!(threaded[2].parent, SyncParent::Unknown);
}
