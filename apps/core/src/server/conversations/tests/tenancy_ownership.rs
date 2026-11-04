//! Conversation store tests: tenancy ownership.

use super::*;

#[tokio::test]
async fn claim_tenancy_never_steals_an_already_owned_conversation() {
    // First-writer-wins. Two authenticated callers racing on the same id (or a
    // deliberate re-POST with someone else's conversation id) must not be able to
    // re-tenant a row — the loser is denied by the ACL on their next request.
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("c1", "alice", Some("org1"))
        .await
        .unwrap();
    store
        .claim_tenancy("c1", "mallory", Some("org1"))
        .await
        .unwrap();

    let meta = store.get_access_meta("c1").await.unwrap().expect("row");
    assert_eq!(
        meta.owner_user_id.as_deref(),
        Some("alice"),
        "an owned conversation must never be re-tenanted"
    );
}

#[tokio::test]
async fn appending_a_message_does_not_wipe_the_claimed_owner() {
    // The silent-failure mode: `append_message` upserts the conversation row, so
    // if its ON CONFLICT clause rewrote the tenancy columns the claim would be
    // erased the moment the first message landed and the gate would go vacuous
    // again with every test still green.
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("c1", "alice", Some("org1"))
        .await
        .unwrap();
    store
        .append_message("c1", "user", "hello", Some("ryu"), Some("alice"), None)
        .await
        .unwrap();

    let meta = store.get_access_meta("c1").await.unwrap().expect("row");
    assert_eq!(meta.owner_user_id.as_deref(), Some("alice"));
    assert_eq!(meta.org_id.as_deref(), Some("org1"));
}

#[tokio::test]
async fn visible_lists_scope_to_the_caller_on_an_org_bound_node() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("alice-chat", "alice", Some("org1"))
        .await
        .unwrap();
    store
        .append_message("alice-chat", "user", "secret", None, None, None)
        .await
        .unwrap();
    store
        .claim_tenancy("bob-chat", "bob", Some("org1"))
        .await
        .unwrap();
    store
        .append_message("bob-chat", "user", "hi", None, None, None)
        .await
        .unwrap();
    // A pre-ACL row: no owner, no org. On a bound node it is unattributable.
    store
        .ensure_conversation("legacy", None, None, Tenancy::Unattributed)
        .await
        .unwrap();

    // Bob, on the org-bound node, sees only his own.
    let bob = store
        .list_conversations_visible(Some("bob"), Some("org1"), true)
        .await
        .unwrap();
    let ids: Vec<&str> = bob.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, vec!["bob-chat"], "bob must not see alice's chat");

    // Anonymous on a bound node: nothing.
    assert!(store
        .list_conversations_visible(None, None, true)
        .await
        .unwrap()
        .is_empty());

    // The same node UNBOUND (personal, local-first): everything, unchanged.
    assert_eq!(
        store
            .list_conversations_visible(None, None, false)
            .await
            .unwrap()
            .len(),
        3
    );

    // The search filter agrees with the list filter, so a semantic hit in
    // alice's chat can never surface for bob.
    let searchable = store
        .visible_conversation_ids(Some("bob"), Some("org1"), true)
        .await
        .unwrap();
    assert_eq!(searchable, vec!["bob-chat".to_owned()]);
    assert!(store
        .visible_conversation_ids(None, None, true)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn one_summary_lookup_matches_the_visible_list() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("alice-chat", "alice", Some("org1"))
        .await
        .unwrap();
    store
        .append_message("alice-chat", "user", "secret", None, None, None)
        .await
        .unwrap();
    store
        .claim_tenancy("bob-chat", "bob", Some("org1"))
        .await
        .unwrap();
    store
        .append_message("bob-chat", "user", "hi", None, None, None)
        .await
        .unwrap();

    let own = store
        .get_summary_visible("bob-chat", Some("bob"), Some("org1"), true)
        .await
        .unwrap()
        .expect("bob sees his chat");
    let listed = store
        .list_conversations_visible(Some("bob"), Some("org1"), true)
        .await
        .unwrap()
        .into_iter()
        .find(|c| c.id == "bob-chat")
        .unwrap();
    assert_eq!(own.id, listed.id);
    assert_eq!(own.title, listed.title);
    assert_eq!(own.message_count, listed.message_count);
    assert_eq!(own.run_status, listed.run_status);

    assert!(store
        .get_summary_visible("alice-chat", Some("bob"), Some("org1"), true)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .get_summary_visible("missing", None, None, false)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn an_org_visible_conversation_is_listed_for_other_members() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("shared", "alice", Some("org1"))
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE conversations SET visibility = 'org' WHERE id = 'shared'",
            [],
        )
        .unwrap();
    }
    let bob = store
        .list_conversations_visible(Some("bob"), Some("org1"), true)
        .await
        .unwrap();
    assert_eq!(bob.len(), 1, "an org-visible chat is shared with the org");

    // …but not with a different org.
    let outsider = store
        .list_conversations_visible(Some("mallory"), Some("org2"), true)
        .await
        .unwrap();
    assert!(outsider.is_empty(), "cross-org must never see the row");
}

#[tokio::test]
async fn a_fork_is_owned_by_the_forker_not_the_source_owner() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("src", "alice", Some("org1"))
        .await
        .unwrap();
    store
        .append_message("src", "user", "shared thought", None, None, None)
        .await
        .unwrap();

    let forked = store
        .fork_conversation(
            "src",
            None,
            Tenancy::Owned {
                user_id: "bob".to_owned(),
                org_id: Some("org1".to_owned()),
            },
        )
        .await
        .unwrap()
        .expect("fork");
    let meta = store
        .get_access_meta(&forked.id)
        .await
        .unwrap()
        .expect("row");
    assert_eq!(meta.owner_user_id.as_deref(), Some("bob"));
    assert_eq!(meta.org_id.as_deref(), Some("org1"));
}

#[tokio::test]
async fn conversation_folder_can_be_cleared_without_deleting_the_chat() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation(
            "project-chat",
            None,
            Some("Project chat"),
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    assert!(store
        .set_folder_path("project-chat", Some(r"C:\Code\ryu\"))
        .await
        .unwrap());
    let grouped = store
        .list_conversations()
        .await
        .unwrap()
        .into_iter()
        .find(|conversation| conversation.id == "project-chat")
        .expect("conversation summary");
    assert_eq!(grouped.folder_path.as_deref(), Some(r"C:\Code\ryu"));

    assert!(store.set_folder_path("project-chat", None).await.unwrap());
    let detached = store
        .list_conversations()
        .await
        .unwrap()
        .into_iter()
        .find(|conversation| conversation.id == "project-chat")
        .expect("conversation remains");
    assert_eq!(detached.folder_path, None);
}

// ══════════════════════════════════════════════════════════════════════════
// THE CHOKE POINT (task item 1): "no owner is ever locked out of their own
// conversation, whichever path created it".
//
// These are the tests that catch a fix which trades a leak for an OUTAGE. The
// regression they guard: tenancy used to be stamped at a handful of HANDLERS, so
// every other creation path (MCP `create_thread`/`fork_thread`, sync replay, the
// healing simulator, …) minted a NULL-tenanted row — and on an org-bound node
// NULL means DENIED TO EVERYONE, including the row's rightful owner.
// ══════════════════════════════════════════════════════════════════════════

pub(super) const ORG: &str = "org1";

pub(super) fn alice() -> Tenancy {
    Tenancy::Owned {
        user_id: "alice".to_owned(),
        org_id: Some(ORG.to_owned()),
    }
}

/// The owner can actually SEE the row on a bound node (the same SQL predicate the
/// HTTP list/search and the MCP tools all filter with), and the row's stored
/// tenancy names them.
pub(super) async fn assert_owner_can_reach(store: &ConversationStore, id: &str, path: &str) {
    let meta = store
        .get_access_meta(id)
        .await
        .unwrap()
        .unwrap_or_else(|| panic!("[{path}] no conversation row at all"));
    assert_eq!(
        meta.owner_user_id.as_deref(),
        Some("alice"),
        "[{path}] created an UNTENANTED row — on an org-bound node its own owner is locked out of it"
    );
    assert_eq!(
        meta.org_id.as_deref(),
        Some(ORG),
        "[{path}] org not stamped"
    );

    let visible = store
        .visible_conversation_ids(Some("alice"), Some(ORG), true)
        .await
        .unwrap();
    assert!(
        visible.iter().any(|v| v == id),
        "[{path}] the owner cannot see their own conversation on a bound node"
    );

    // …and a DIFFERENT user on the same org still cannot.
    let bobs = store
        .visible_conversation_ids(Some("bob"), Some(ORG), true)
        .await
        .unwrap();
    assert!(
        !bobs.iter().any(|v| v == id),
        "[{path}] a private conversation leaked into another member's visible set"
    );
}

/// EVERY creation path, table-driven. A future path added without a `Tenancy`
/// cannot compile; a future path added WITH the wrong one fails here.
#[tokio::test]
async fn every_creation_path_leaves_the_row_reachable_by_its_own_owner() {
    // 1. ensure_conversation (MCP `create_thread`, sync replay, healing sim).
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("c-ensure", None, Some("t"), alice())
        .await
        .unwrap();
    assert_owner_can_reach(&store, "c-ensure", "ensure_conversation").await;

    // 2. append_message_as minting a fresh row (channel/bot ingress, import).
    store
        .append_message_as("c-append", "user", "hi", None, None, None, alice())
        .await
        .unwrap();
    assert_owner_can_reach(&store, "c-append", "append_message_as").await;

    // 3. append_message_with_id (the sync-replay insert).
    store
        .append_message_with_id("c-withid", "m1", "user", "hi", None, 1, alice())
        .await
        .unwrap();
    assert_owner_can_reach(&store, "c-withid", "append_message_with_id").await;

    // 4. add_participant (council chat's first agent).
    store
        .add_participant("c-part", "agent-a", alice())
        .await
        .unwrap();
    assert_owner_can_reach(&store, "c-part", "add_participant").await;

    // 5. create_session.
    let session = store
        .create_session("agent-a", RunnableKind::Agent, None, None, alice())
        .await
        .unwrap();
    assert_owner_can_reach(&store, &session.conversation_id, "create_session").await;

    // 6. fork_conversation (HTTP fork + the MCP `fork_thread` tool).
    let forked = store
        .fork_conversation("c-append", None, alice())
        .await
        .unwrap()
        .expect("fork");
    assert_owner_can_reach(&store, &forked.id, "fork_conversation").await;

    // 7. claim_tenancy (the repair/backfill entry, still first-writer-wins).
    store
        .claim_tenancy("c-claim", "alice", Some(ORG))
        .await
        .unwrap();
    assert_owner_can_reach(&store, "c-claim", "claim_tenancy").await;
}

/// The preserve-not-clobber half of the choke point, at every layer that upserts
/// an EXISTING row: none of them may wipe the owner already stamped.
#[tokio::test]
async fn no_upsert_path_can_wipe_or_steal_a_claimed_owner() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("c1", None, None, alice())
        .await
        .unwrap();

    // Every path that upserts the same id with a DIFFERENT (or absent) tenancy.
    store
        .append_message_as("c1", "user", "hi", None, None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .ensure_conversation("c1", Some("a"), None, Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .append_message_with_id("c1", "m9", "user", "x", None, 2, Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .add_participant("c1", "agent-z", Tenancy::Unattributed)
        .await
        .unwrap();
    // …and a deliberate STEAL attempt with a real, different principal.
    store
        .claim_tenancy("c1", "mallory", Some(ORG))
        .await
        .unwrap();
    store
        .append_message_as(
            "c1",
            "user",
            "mine now",
            None,
            None,
            None,
            Tenancy::Owned {
                user_id: "mallory".to_owned(),
                org_id: Some(ORG.to_owned()),
            },
        )
        .await
        .unwrap();

    let meta = store.get_access_meta("c1").await.unwrap().unwrap();
    assert_eq!(
        meta.owner_user_id.as_deref(),
        Some("alice"),
        "first-writer-wins broken: the conversation was re-tenanted / stolen"
    );
}
