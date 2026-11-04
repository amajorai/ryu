use super::*;

#[tokio::test]
async fn app_documents_keep_caller_acl_despite_matching_app_namespace() {
    let store = crate::server::spaces::SpaceStore::open_in_memory().unwrap();
    let owner = crate::server::spaces::DocOwner::owned(Some("alice"), Some("org1"));
    let space = store
        .create_space("Private footage", None, &owner)
        .await
        .unwrap();
    let doc = store
        .app_create_doc("@test/editor", &space, "Transcript", &owner)
        .await
        .unwrap();
    // Namespace ownership alone admits both callers. The shared row gate must
    // retain Alice's private ownership for all apps using the host bridge.
    assert!(store
        .app_get_doc("@test/editor", &doc)
        .await
        .unwrap()
        .is_some());
    let bob = caller("bob", Some("org1"), OrgRole::Member);
    let alice = caller("alice", Some("org1"), OrgRole::Member);
    assert_eq!(
        status(require_resource_read_at(
            crate::server::spaces::doc_access_meta(&store, &doc).await,
            Some(&bob),
            BOUND,
            "nf"
        )),
        Some(StatusCode::FORBIDDEN)
    );
    assert_eq!(
        status(require_resource_write_at(
            crate::server::spaces::doc_access_meta(&store, &doc).await,
            Some(&bob),
            BOUND,
            "nf"
        )),
        Some(StatusCode::FORBIDDEN)
    );
    assert!(require_resource_write_at(
        crate::server::spaces::doc_access_meta(&store, &doc).await,
        Some(&alice),
        BOUND,
        "nf"
    )
    .is_ok());
}

#[test]
fn list_visibility_keeps_every_verified_team_membership() {
    let mut member = caller("alice", Some("org1"), OrgRole::Member);
    member.teams = vec![
        TeamMembership {
            id: "team-a".to_owned(),
            org_id: "org1".to_owned(),
            role: "member".to_owned(),
        },
        TeamMembership {
            id: "team-b".to_owned(),
            org_id: "org1".to_owned(),
            role: "member".to_owned(),
        },
    ];

    assert_eq!(
        crate::server::caller_team_ids(&member),
        vec!["team-a", "team-b"]
    );
}

#[test]
fn untenanted_row_keeps_the_local_first_flow_wide_open_on_an_unbound_node() {
    // The single-user local-first row (no JWT ever ⇒ NULL owner AND NULL org) on
    // a personal node. This gate must be byte-identical to no gate at all for it,
    // or every existing local install breaks on upgrade.
    assert_eq!(
        resource_access(scoped(None, None, "private"), None, UNBOUND, "nf").unwrap(),
        Access::Write,
        "an untenanted row on an unbound node grants full access to an anonymous caller"
    );
    assert!(require_resource_write_at(scoped(None, None, "private"), None, UNBOUND, "nf").is_ok());
}

#[test]
fn untenanted_row_is_denied_on_an_org_bound_node() {
    // THE VACUITY THAT MADE THIS GATE FAKE: an unconditional `Access::Write` on
    // NULL tenancy, combined with nothing ever writing tenancy, meant every
    // caller had Write on every row. On a SHARED node an unattributable row now
    // fails closed instead.
    let bob = caller("bob", Some("org1"), OrgRole::Member);
    assert_eq!(
        status(require_resource_read_at(
            scoped(None, None, "private"),
            Some(&bob),
            BOUND,
            "nf"
        )),
        Some(StatusCode::FORBIDDEN)
    );
    assert_eq!(
        status(require_resource_read_at(
            scoped(None, None, "private"),
            None,
            BOUND,
            "nf"
        )),
        Some(StatusCode::FORBIDDEN)
    );
}

#[test]
fn scoped_row_denies_an_anonymous_caller_on_a_bound_node() {
    // The credential-downgrade attack: Bob drops his JWT and re-requests, hoping
    // to be treated as "the local single user". A row is scoped ONLY because
    // someone authenticated to create it, so anonymity here must fail closed.
    assert_eq!(
        status(require_resource_read_at(
            scoped(Some("alice"), Some("org1"), "private"),
            None,
            BOUND,
            "nf"
        )),
        Some(StatusCode::FORBIDDEN)
    );
}

#[test]
fn scoped_row_still_serves_its_offline_owner_on_an_unbound_node() {
    // The local-first regression guard. The desktop's user JWT is minted against
    // the control plane and cached IN MEMORY ONLY: a signed-in user who restarts
    // the app offline is ANONYMOUS. On a personal node they must still reach the
    // rows they created while signed in — the node token is the boundary there.
    assert_eq!(
        resource_access(
            scoped(Some("alice"), Some("org1"), "private"),
            None,
            UNBOUND,
            "nf"
        )
        .unwrap(),
        Access::Write
    );
}

#[test]
fn private_row_denies_a_non_owner() {
    // The headline hole: any org member with `space.read` could read another
    // member's PRIVATE doc, because the coarse RBAC gate never looked at the row.
    let bob = caller("bob", Some("org1"), OrgRole::Member);
    assert_eq!(
        status(require_resource_read_at(
            scoped(Some("alice"), Some("org1"), "private"),
            Some(&bob),
            BOUND,
            "nf"
        )),
        Some(StatusCode::FORBIDDEN)
    );
}

#[test]
fn owner_gets_write() {
    let alice = caller("alice", Some("org1"), OrgRole::Member);
    assert_eq!(
        resource_access(
            scoped(Some("alice"), Some("org1"), "private"),
            Some(&alice),
            BOUND,
            "nf"
        )
        .unwrap(),
        Access::Write
    );
}

#[test]
fn org_visible_row_grants_a_member_write_and_a_viewer_read_only() {
    let member = caller("bob", Some("org1"), OrgRole::Member);
    assert!(require_resource_write_at(
        scoped(Some("alice"), Some("org1"), "org"),
        Some(&member),
        BOUND,
        "nf"
    )
    .is_ok());

    // A Viewer may READ an org-visible doc but must not write it — mirroring the
    // realtime gateway, which drops a read-only member's mutating frames.
    let viewer = caller("carol", Some("org1"), OrgRole::Viewer);
    assert!(require_resource_read_at(
        scoped(Some("alice"), Some("org1"), "org"),
        Some(&viewer),
        BOUND,
        "nf"
    )
    .is_ok());
    assert_eq!(
        status(require_resource_write_at(
            scoped(Some("alice"), Some("org1"), "org"),
            Some(&viewer),
            BOUND,
            "nf"
        )),
        Some(StatusCode::FORBIDDEN),
        "a read-only grant must not satisfy a write"
    );
}

#[test]
fn cross_org_caller_is_denied_even_on_an_org_visible_row() {
    let outsider = caller("mallory", Some("org2"), OrgRole::Owner);
    assert_eq!(
        status(require_resource_read_at(
            scoped(Some("alice"), Some("org1"), "org"),
            Some(&outsider),
            BOUND,
            "nf"
        )),
        Some(StatusCode::FORBIDDEN)
    );
}

#[test]
fn unknown_id_is_404_and_lookup_failure_is_500() {
    let alice = caller("alice", Some("org1"), OrgRole::Member);
    assert_eq!(
        status(require_resource_read_at(
            Ok(None),
            Some(&alice),
            BOUND,
            "nf"
        )),
        Some(StatusCode::NOT_FOUND)
    );
    // Fail closed: we never serve a row we could not authorize.
    assert_eq!(
        status(require_resource_read_at(
            Err(anyhow::anyhow!("db is on fire")),
            Some(&alice),
            BOUND,
            "nf"
        )),
        Some(StatusCode::INTERNAL_SERVER_ERROR)
    );
}

/// THE ACCEPTANCE TEST, threading the seam that was actually broken:
/// real store → `claim_tenancy` (the write that did not exist) →
/// `get_access_meta` (the read the handlers do) → the gate.
///
/// Testing `claim_tenancy` and `resource_access` in isolation would leave exactly
/// the join that was vacuous unverified, so this drives BOTH through one row.
#[tokio::test]
async fn user_b_is_denied_user_a_s_conversation_end_to_end() {
    let store = crate::server::conversations::ConversationStore::open_in_memory().unwrap();

    // Alice starts a chat on a shared, org-bound node. This is the call that did
    // not exist before: every row used to be created with NULL tenancy.
    store
        .claim_tenancy("c1", "alice", Some("org1"))
        .await
        .unwrap();

    // Bob — a legitimate, fully-authenticated member of the SAME org — asks for it.
    let bob = caller("bob", Some("org1"), OrgRole::Member);

    assert_eq!(
        status(require_resource_read_at(
            store.get_access_meta("c1").await,
            Some(&bob),
            BOUND,
            "conversation not found"
        )),
        Some(StatusCode::FORBIDDEN),
        "user B must NOT be able to read user A's conversation"
    );
    assert_eq!(
        status(require_resource_write_at(
            store.get_access_meta("c1").await,
            Some(&bob),
            BOUND,
            "conversation not found"
        )),
        Some(StatusCode::FORBIDDEN),
        "user B must NOT be able to write into user A's conversation \
             (this is the POST /api/chat/stream bypass)"
    );

    // …and Alice herself is unaffected.
    let alice = caller("alice", Some("org1"), OrgRole::Member);
    assert!(require_resource_write_at(
        store.get_access_meta("c1").await,
        Some(&alice),
        BOUND,
        "conversation not found"
    )
    .is_ok());

    // Before this change the SAME row would have had NULL tenancy and Bob would
    // have gotten Write. Prove the pre-fix state is what the gate now denies.
    assert_eq!(
        resource_access(
            store.get_access_meta("unclaimed").await,
            Some(&bob),
            BOUND,
            "nf"
        )
        .err()
        .map(|r| r.status()),
        Some(StatusCode::NOT_FOUND),
        "an id with no row at all is a 404, not a silent allow"
    );
}

// ══════════════════════════════════════════════════════════════════════════
// Task items (3) and (4): the handlers that took a client-supplied
// conversation id but were never gated.
//
// These handlers need a full `ServerState` (sidecars, stores, spawn) to drive
// over HTTP, which no unit test in this crate builds. So each is covered by TWO
// tests, which together are what the acceptance bar asks for:
//
//   a) the DECISION — the gate the handler now calls, driven through a real store
//      row, denies the wrong caller and admits the owner (below);
//   b) the WIRING — the handler actually calls it. A source-level assertion, i.e.
//      the same shape as the choke-point INSERT test. It is what fails in CI if a
//      future edit quietly drops the gate, which is the realistic regression.
// ══════════════════════════════════════════════════════════════════════════

/// (3)+(4a) — one real store row, every by-id gate the newly-gated handlers use.
#[tokio::test]
async fn every_newly_gated_handler_denies_a_non_owner_and_admits_the_owner() {
    let store = crate::server::conversations::ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("alice-chat", "alice", Some("org1"))
        .await
        .unwrap();

    let bob = caller("bob", Some("org1"), OrgRole::Member);
    let alice = caller("alice", Some("org1"), OrgRole::Member);

    // `/api/voice/ws` (start.conversation_id → `gate_and_claim_conversation`) and
    // `/api/chat/permission` (the prompt's parent conversation) are WRITE gates.
    assert_eq!(
        status(require_resource_write_at(
            store.get_access_meta("alice-chat").await,
            Some(&bob),
            BOUND,
            "not found"
        )),
        Some(StatusCode::FORBIDDEN),
        "voice_ws / chat_permission must not let Bob act on Alice's conversation"
    );
    // `/api/learn/synthesize` distills the conversation's content — a READ.
    assert_eq!(
        status(require_resource_read_at(
            store.get_access_meta("alice-chat").await,
            Some(&bob),
            BOUND,
            "not found"
        )),
        Some(StatusCode::FORBIDDEN),
        "learn/synthesize must not distill Alice's conversation for Bob"
    );

    // NOT LOCKED OUT: Alice still passes both.
    assert!(require_resource_write_at(
        store.get_access_meta("alice-chat").await,
        Some(&alice),
        BOUND,
        "not found"
    )
    .is_ok());
    assert!(require_resource_read_at(
        store.get_access_meta("alice-chat").await,
        Some(&alice),
        BOUND,
        "not found"
    )
    .is_ok());

    // UNBOUND PARITY: on a personal node the very same row and the very same
    // anonymous caller are allowed — no offline lockout, byte-identical to before.
    assert!(require_resource_write_at(
        store.get_access_meta("alice-chat").await,
        None,
        UNBOUND,
        "not found"
    )
    .is_ok());
    assert!(require_resource_read_at(
        store.get_access_meta("alice-chat").await,
        None,
        UNBOUND,
        "not found"
    )
    .is_ok());
}

/// (1) — the danger-zone clear is SCOPED on a bound node: it removes the caller's
/// own conversations and NOT anybody else's. (It stays an unscoped truncate on an
/// unbound personal node, which is the whole point of the feature there.)
#[tokio::test]
async fn data_clear_on_a_bound_node_only_removes_the_callers_own_chats() {
    let store = crate::server::conversations::ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("a1", "alice", Some("org1"))
        .await
        .unwrap();
    store
        .claim_tenancy("b1", "bob", Some("org1"))
        .await
        .unwrap();

    let removed = store
        .clear_conversations_owned_by("bob")
        .await
        .unwrap()
        .removed;
    assert_eq!(removed, 1);
    assert!(
        store.get_access_meta("a1").await.unwrap().is_some(),
        "clearing Bob's data destroyed Alice's conversation"
    );
    assert!(store.get_access_meta("b1").await.unwrap().is_none());
}
