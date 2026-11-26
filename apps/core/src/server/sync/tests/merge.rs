//! Conversation payload round trips, merges and replay attribution.

use super::*;
use crate::server::sync::payloads::{apply_sync_payload, build_sync_payload};

/// Proves "two DBs, one synced conversation" (AC2):
/// - store_a gets messages appended,
/// - a payload is built from store_a,
/// - the payload is applied to store_b,
/// - store_b now has identical messages.
#[tokio::test]
async fn round_trip_two_stores() {
    let store_a = ConversationStore::open_in_memory().unwrap();
    let store_b = ConversationStore::open_in_memory().unwrap();

    store_a
        .append_message(
            "conv-sync-1",
            "user",
            "hello from A",
            Some("agent-1"),
            None,
            None,
        )
        .await
        .unwrap();
    store_a
        .append_message(
            "conv-sync-1",
            "assistant",
            "hi back",
            Some("agent-1"),
            None,
            None,
        )
        .await
        .unwrap();

    // Export from A.
    let payload = build_sync_payload(&store_a, "conv-sync-1").await.unwrap();

    assert_eq!(payload.conversation_id, "conv-sync-1");
    assert_eq!(payload.messages.len(), 2);

    // Apply to B — this is "device B receiving the sync payload".
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();

    let msgs_a = store_a.get_messages("conv-sync-1").await.unwrap();
    let msgs_b = store_b.get_messages("conv-sync-1").await.unwrap();

    assert_eq!(msgs_a.len(), msgs_b.len(), "message counts must match");
    for (a, b) in msgs_a.iter().zip(msgs_b.iter()) {
        assert_eq!(a.role, b.role);
        assert_eq!(a.content, b.content);
    }

    let list_b = store_b.list_conversations().await.unwrap();
    assert_eq!(list_b.len(), 1);
    assert_eq!(list_b[0].id, "conv-sync-1");
}

/// Union-merge: applying the same payload twice must not duplicate messages.
#[tokio::test]
async fn idempotent_apply() {
    let store_a = ConversationStore::open_in_memory().unwrap();
    let store_b = ConversationStore::open_in_memory().unwrap();

    store_a
        .append_message("conv-idem", "user", "msg1", None, None, None)
        .await
        .unwrap();

    let payload = build_sync_payload(&store_a, "conv-idem").await.unwrap();

    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();
    apply_sync_payload(&store_b, &payload, Tenancy::Unattributed)
        .await
        .unwrap();

    let msgs = store_b.get_messages("conv-idem").await.unwrap();
    assert_eq!(
        msgs.len(),
        1,
        "idempotent apply must not duplicate messages"
    );
}

/// LWW: a subsequent apply with an older `updated_at` must not clobber
/// newer metadata already in the store.
#[tokio::test]
async fn lww_metadata_newer_wins() {
    let store_b = ConversationStore::open_in_memory().unwrap();

    // Construct payloads manually with controlled timestamps so the test
    // is deterministic regardless of wall-clock ordering.
    let base_ts: i64 = 1_700_000_000_000;

    // "Fresh" payload has a higher updated_at.
    let fresh = SyncPayload {
        conversation_id: "conv-lww".to_string(),
        title: Some("fresh title".to_string()),
        agent_id: Some("agent-1".to_string()),
        folder_path: None,
        branch: None,
        worktree_path: None,
        run_status: None,
        owner_user_id: None,
        created_at: base_ts,
        updated_at: base_ts + 2000,
        messages: vec![SyncMessage {
            id: "msg-1".to_string(),
            role: "user".to_string(),
            content: "hello".to_string(),
            created_at: base_ts,
            parent_message_id: None,
            version_root: false,
        }],
    };

    // "Stale" payload has a lower updated_at.
    let stale = SyncPayload {
        conversation_id: "conv-lww".to_string(),
        title: Some("stale title".to_string()),
        agent_id: Some("agent-1".to_string()),
        folder_path: None,
        branch: None,
        worktree_path: None,
        run_status: None,
        owner_user_id: None,
        created_at: base_ts,
        updated_at: base_ts + 1000,
        messages: vec![SyncMessage {
            id: "msg-1".to_string(),
            role: "user".to_string(),
            content: "hello".to_string(),
            created_at: base_ts,
            parent_message_id: None,
            version_root: false,
        }],
    };

    // Apply fresh first, then stale — stale must not overwrite.
    apply_sync_payload(&store_b, &fresh, Tenancy::Unattributed)
        .await
        .unwrap();
    apply_sync_payload(&store_b, &stale, Tenancy::Unattributed)
        .await
        .unwrap();

    let summaries = store_b.list_conversations().await.unwrap();
    let title = summaries[0].title.as_deref().unwrap_or("");
    assert_eq!(
        title, "fresh title",
        "LWW: stale payload must not overwrite newer title"
    );
}

/// Incremental push: new messages from a second device are merged in.
#[tokio::test]
async fn incremental_merge_new_messages() {
    let store_a = ConversationStore::open_in_memory().unwrap();
    let store_b = ConversationStore::open_in_memory().unwrap();

    store_a
        .append_message("conv-incr", "user", "first", None, None, None)
        .await
        .unwrap();

    let p1 = build_sync_payload(&store_a, "conv-incr").await.unwrap();
    apply_sync_payload(&store_b, &p1, Tenancy::Unattributed)
        .await
        .unwrap();

    // A second message added after the first sync.
    store_a
        .append_message("conv-incr", "assistant", "second", None, None, None)
        .await
        .unwrap();

    let p2 = build_sync_payload(&store_a, "conv-incr").await.unwrap();
    apply_sync_payload(&store_b, &p2, Tenancy::Unattributed)
        .await
        .unwrap();

    let msgs = store_b.get_messages("conv-incr").await.unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].content, "first");
    assert_eq!(msgs[1].content, "second");
}

/// A payload carrying an author + built via [`build_sync_payload`] round-trips
/// the OWNER too, so the receiving node can re-attribute the replay.
#[tokio::test]
async fn build_sync_payload_carries_the_source_owner() {
    let store = ConversationStore::open_in_memory().unwrap();
    // Stamp an owner the way a bound-node write does (claim_tenancy choke point).
    store
        .claim_tenancy("owned-conv", "bob", Some("org1"))
        .await
        .unwrap();
    store
        .append_message("owned-conv", "user", "hi", None, None, None)
        .await
        .unwrap();

    let payload = build_sync_payload(&store, "owned-conv").await.unwrap();
    assert_eq!(
        payload.owner_user_id.as_deref(),
        Some("bob"),
        "the source row's author must ride the sync payload"
    );

    // An unbound (NULL-tenanted) row carries no author — byte-identical wire.
    let store2 = ConversationStore::open_in_memory().unwrap();
    store2
        .append_message("anon-conv", "user", "hi", None, None, None)
        .await
        .unwrap();
    let anon = build_sync_payload(&store2, "anon-conv").await.unwrap();
    assert!(anon.owner_user_id.is_none());
    assert!(
        !serde_json::to_string(&anon)
            .unwrap()
            .contains("owner_user_id"),
        "an author-less payload must serialize byte-identical to the pre-owner wire"
    );
}

/// THE correctness seam (mirrors the ACL round's `resource_acl_tests`): a replay
/// on a bound node lands owned by the PAYLOAD's author — visible to that author,
/// DENIED to a different org member — never the pulling device's own account. An
/// author-less payload on a bound node is REFUSED (fail closed).
#[tokio::test]
async fn replay_attributes_to_payload_author_not_the_pulling_device() {
    let store = ConversationStore::open_in_memory().unwrap();

    // The receiving loop's CONTEXT: this device is signed in as "device-owner"
    // on org "org1". That account must NEVER end up owning a pulled row.
    let ctx = Tenancy::Owned {
        user_id: "device-owner".to_owned(),
        org_id: Some("org1".to_owned()),
    };

    // A payload authored by "bob" on another node.
    let bobs = SyncPayload {
        conversation_id: "bob-synced".to_owned(),
        title: Some("bob's chat".to_owned()),
        agent_id: None,
        folder_path: None,
        branch: None,
        worktree_path: None,
        run_status: None,
        owner_user_id: Some("bob".to_owned()),
        created_at: 1,
        updated_at: 1,
        messages: vec![SyncMessage {
            id: "m1".to_owned(),
            role: "user".to_owned(),
            content: "secret".to_owned(),
            created_at: 1,
            parent_message_id: None,
            version_root: false,
        }],
    };

    // Replay on the BOUND node (node_bound = true), under the device context.
    apply_sync_payload_at(&store, &bobs, ctx.clone(), true)
        .await
        .unwrap();

    // The row is owned by BOB (the payload author), scoped to the node's org —
    // NOT "device-owner".
    let meta = store
        .get_access_meta("bob-synced")
        .await
        .unwrap()
        .expect("row");
    assert_eq!(meta.owner_user_id.as_deref(), Some("bob"));
    assert_eq!(meta.org_id.as_deref(), Some("org1"));

    // Bob can reach it; the pulling device account (a different member) cannot.
    let bob_sees = store
        .list_conversations_visible(Some("bob"), Some("org1"), true)
        .await
        .unwrap();
    assert_eq!(
        bob_sees.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        vec!["bob-synced"],
        "the original author must see the replayed row"
    );
    let device_sees = store
        .list_conversations_visible(Some("device-owner"), Some("org1"), true)
        .await
        .unwrap();
    assert!(
        device_sees.is_empty(),
        "the pulling device account must NOT be able to read bob's replayed chat"
    );

    // An author-less payload on a bound node is REFUSED (fail closed) — no row.
    let orphan = SyncPayload {
        conversation_id: "orphan".to_owned(),
        title: None,
        agent_id: None,
        folder_path: None,
        branch: None,
        worktree_path: None,
        run_status: None,
        owner_user_id: None,
        created_at: 1,
        updated_at: 1,
        messages: vec![],
    };
    assert!(
        apply_sync_payload_at(&store, &orphan, ctx, true)
            .await
            .is_err(),
        "an author-less replay on a bound node must fail closed, not mint an unreachable row"
    );
    assert!(store.get_access_meta("orphan").await.unwrap().is_none());

    // On an UNBOUND node the same authored payload stays NULL-tenanted
    // (byte-identical local-first behaviour: author ignored, no attribution).
    let unbound = ConversationStore::open_in_memory().unwrap();
    apply_sync_payload_at(&unbound, &bobs, Tenancy::Unattributed, false)
        .await
        .unwrap();
    let meta = unbound
        .get_access_meta("bob-synced")
        .await
        .unwrap()
        .expect("row");
    assert!(
        meta.owner_user_id.is_none() && meta.org_id.is_none(),
        "an unbound node must not attribute a replayed row (byte-identical)"
    );
}

/// Requirement (3) at the replay seam: a replay can NEVER re-tenant/steal an
/// existing row. A row already owned by "alice" must survive a hostile replay
/// whose payload claims a different author ("attacker") — first-writer-wins via
/// the store's COALESCE. Proven here at the sync layer (the store has its own
/// `claim_tenancy_never_steals_*` test; this guards the apply path specifically).
#[tokio::test]
async fn replay_cannot_retenant_an_already_owned_row() {
    let store = ConversationStore::open_in_memory().unwrap();

    // Pre-existing row owned by alice on org1 (the first writer).
    store
        .claim_tenancy("shared", "alice", Some("org1"))
        .await
        .unwrap();

    // A hostile payload for the SAME conversation, claiming a different author.
    let hostile = SyncPayload {
        conversation_id: "shared".to_owned(),
        title: Some("hijack".to_owned()),
        agent_id: None,
        folder_path: None,
        branch: None,
        worktree_path: None,
        run_status: None,
        owner_user_id: Some("attacker".to_owned()),
        created_at: 1,
        updated_at: i64::MAX, // even a "newer" LWW metadata write must not re-tenant.
        messages: vec![SyncMessage {
            id: "m1".to_owned(),
            role: "user".to_owned(),
            content: "steal".to_owned(),
            created_at: 1,
            parent_message_id: None,
            version_root: false,
        }],
    };

    // Replay on the bound node under a device context (owner is resolved from the
    // payload author, but the row already exists → COALESCE keeps alice).
    let ctx = Tenancy::Owned {
        user_id: "device-owner".to_owned(),
        org_id: Some("org1".to_owned()),
    };
    apply_sync_payload_at(&store, &hostile, ctx, true)
        .await
        .unwrap();

    // Owner is STILL alice — never the payload's "attacker", never the device.
    let meta = store.get_access_meta("shared").await.unwrap().expect("row");
    assert_eq!(
        meta.owner_user_id.as_deref(),
        Some("alice"),
        "a replay must not re-tenant an already-owned row (first-writer-wins)"
    );
    assert_eq!(meta.org_id.as_deref(), Some("org1"));

    // Alice still sees it; the claimed "attacker" cannot.
    let attacker_sees = store
        .list_conversations_visible(Some("attacker"), Some("org1"), true)
        .await
        .unwrap();
    assert!(
        attacker_sees.is_empty(),
        "the impersonated author must not gain access by claiming ownership in a payload"
    );
}
