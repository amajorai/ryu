/// (3)+(4b) — THE WIRING. Each handler must actually invoke its gate. This is the
/// assertion that fails if someone deletes the gate while keeping the handler.
#[test]
fn the_newly_gated_handlers_actually_call_their_gate() {
    // (3) `/api/voice/ws` lives on the PUBLIC router (a browser WS upgrade cannot
    // set headers), so it must consume a Core-issued ticket and gate the
    // client-supplied conversation_id.
    let voice = include_str!("../../voice_ws.rs");
    assert!(
        voice.contains("ws_ticket::consume"),
        "voice_ws no longer consumes a Core-issued ticket"
    );
    assert!(
        voice.contains("gate_and_claim_conversation"),
        "voice_ws no longer gates its client-supplied conversation_id — this is the \
             exact POST /api/chat/stream bypass, re-opened"
    );

    // (4) `/api/learn/synthesize` distills a client-supplied conversation.
    assert!(
        include_str!("../../learning.rs").contains("require_conversation_read_by_id"),
        "learn/synthesize no longer gates its conversation_id"
    );

    // (4) `/api/data/clear` must never be an unscoped truncate on a bound node.
    let data_admin = include_str!("../../data_admin.rs");
    assert!(
        data_admin.contains("clear_conversations_owned_by"),
        "data/clear no longer scopes the chat wipe to the caller's own rows"
    );
    assert!(
        data_admin.contains("VerifiedCaller"),
        "data/clear no longer reads a caller — any node-token holder can wipe every \
             user's data again"
    );

    // (4) `/api/chat/permission` gates on the parent conversation of the pending
    // request (its body carries no conversation_id — the ids are `perm-<seq>` and
    // trivially guessable, so this is a HITL-integrity gate).
    //
    // NOTE: this test once lived in the file it scans, where a plain
    // `.contains("peek_permission_scope")` matched the ASSERTION rather than the
    // handler and passed unconditionally. The needles stay split, so the
    // contiguous literal exists ONLY in the handler.
    let this_file = crate::server::tests::source_text::server_source();
    let peek = ["peek_permission", "_scope("].concat();
    assert!(
        this_file.contains(&peek),
        "chat_permission no longer resolves the prompt's parent conversation"
    );

    // (4) `/api/retrieval/search` must at minimum refuse a tokenless caller on a
    // bound node (the cross-user space CONTENT leak is NOT closed here — it needs
    // the Spaces tenancy unit, since spaces/documents carry no owner columns).
    let space_read = ["permissions::", "SPACE_READ,"].concat();
    assert!(
        this_file.contains(&space_read),
        "retrieval/search no longer enforces any permission — any node-token holder \
             can pull RAG chunks out of every user's spaces again"
    );
}

/// (1) — the sync replay REFUSES rather than minting rows nobody can read.
#[tokio::test]
async fn sync_replay_refuses_to_mint_untenanted_rows_on_a_bound_node() {
    use crate::server::conversations::Tenancy;
    use crate::server::sync::{apply_sync_payload_at, SyncPayload};

    let store = crate::server::conversations::ConversationStore::open_in_memory().unwrap();
    // The payload carries its ORIGINAL author ("alice") — the row's owner comes
    // from here, not from the receiving loop's context.
    let payload = SyncPayload {
        conversation_id: "synced".to_owned(),
        title: Some("t".to_owned()),
        agent_id: None,
        folder_path: None,
        branch: None,
        worktree_path: None,
        run_status: None,
        owner_user_id: Some("alice".to_owned()),
        created_at: 1,
        updated_at: 1,
        messages: vec![],
    };

    // BOUND node + no context principal ⇒ refuse (the row would be denied to
    // everyone). An `Unattributed` context forces `Unattributed` regardless of the
    // payload's author, so this is the fail-closed path.
    assert!(
        apply_sync_payload_at(&store, &payload, Tenancy::Unattributed, true)
            .await
            .is_err()
    );
    assert!(store.get_access_meta("synced").await.unwrap().is_none());

    // BOUND node + an org context ⇒ the replayed row is born owned by the
    // PAYLOAD's author (alice), scoped to the node's org, and reachable. The
    // context's own `user_id` is never stamped onto the pulled row.
    apply_sync_payload_at(
        &store,
        &payload,
        Tenancy::Owned {
            user_id: "device-owner".to_owned(),
            org_id: Some("org1".to_owned()),
        },
        true,
    )
    .await
    .unwrap();
    assert_eq!(
        store
            .get_access_meta("synced")
            .await
            .unwrap()
            .unwrap()
            .owner_user_id
            .as_deref(),
        Some("alice")
    );

    // UNBOUND node ⇒ unchanged: an unattributed replay is fine and stays NULL.
    let store2 = crate::server::conversations::ConversationStore::open_in_memory().unwrap();
    apply_sync_payload_at(&store2, &payload, Tenancy::Unattributed, false)
        .await
        .unwrap();
    assert!(store2
        .get_access_meta("synced")
        .await
        .unwrap()
        .unwrap()
        .owner_user_id
        .is_none());
}
