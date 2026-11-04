//! Conversation store tests: visibility and choke point.

use super::*;

#[tokio::test]
async fn conversation_visibility_controls_visible_summaries_and_previews() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("alice-chat", "alice", Some("org1"))
        .await
        .unwrap();
    store
        .append_message(
            "alice-chat",
            "user",
            "shared roadmap",
            None,
            Some("alice"),
            None,
        )
        .await
        .unwrap();

    let bob_private = store
        .list_conversations_visible(Some("bob"), Some("org1"), true)
        .await
        .unwrap();
    assert!(bob_private.is_empty());

    assert!(store
        .set_visibility("alice-chat", "org", None, true)
        .await
        .unwrap());
    let bob_shared = store
        .list_conversations_visible_with_preview(Some("bob"), Some("org1"), true)
        .await
        .unwrap();
    assert_eq!(bob_shared.len(), 1);
    assert_eq!(bob_shared[0].visibility, "org");
    assert_eq!(
        bob_shared[0].last_message.as_deref(),
        Some("shared roadmap")
    );

    let meta = store
        .get_access_meta("alice-chat")
        .await
        .unwrap()
        .expect("conversation ACL metadata");
    assert_eq!(meta.visibility, "org");

    assert!(store
        .set_visibility("alice-chat", "private", None, false)
        .await
        .is_err());
    assert!(store
        .set_visibility("alice-chat", "private", None, true)
        .await
        .unwrap());
    assert!(store
        .list_conversations_visible(Some("bob"), Some("org1"), true)
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .set_visibility("alice-chat", "team", None, true)
        .await
        .is_err());
}

#[tokio::test]
async fn direct_conversation_grants_are_atomic_and_org_scoped() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("direct-chat", "alice", Some("org1"))
        .await
        .unwrap();
    store
        .append_message(
            "direct-chat",
            "user",
            "private roadmap",
            None,
            Some("alice"),
            None,
        )
        .await
        .unwrap();
    let collaborators = vec![
        ConversationCollaborator {
            user_id: "bob".to_owned(),
            role: "viewer".to_owned(),
        },
        ConversationCollaborator {
            user_id: "carol".to_owned(),
            role: "participant".to_owned(),
        },
    ];
    assert!(store
        .set_access("direct-chat", "private", None, &collaborators, true)
        .await
        .unwrap());

    let bob_visible = store
        .list_conversations_visible(Some("bob"), Some("org1"), true)
        .await
        .unwrap();
    assert_eq!(bob_visible.len(), 1);
    assert!(store
        .list_conversations_visible(Some("bob"), Some("org2"), true)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store.list_collaborators("direct-chat").await.unwrap(),
        collaborators
    );
    let meta = store.get_access_meta("direct-chat").await.unwrap().unwrap();
    assert_eq!(meta.collaborators.len(), 2);
    assert_eq!(
        meta.collaborators[0].access,
        crate::identity_verify::Access::Read
    );
    assert_eq!(
        meta.collaborators[1].access,
        crate::identity_verify::Access::Write
    );

    let duplicates = vec![collaborators[0].clone(), collaborators[0].clone()];
    assert!(store
        .set_access("direct-chat", "org", None, &duplicates, true)
        .await
        .is_err());
    assert_eq!(
        store.list_collaborators("direct-chat").await.unwrap(),
        collaborators
    );
    assert_eq!(
        store
            .get_access_meta("direct-chat")
            .await
            .unwrap()
            .unwrap()
            .visibility,
        "private"
    );
}

#[tokio::test]
async fn team_visibility_requires_verified_team_membership_for_list_preview_and_search() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("team-chat", "alice", Some("org1"))
        .await
        .unwrap();
    store
        .append_message(
            "team-chat",
            "user",
            "team-only roadmap",
            None,
            Some("alice"),
            None,
        )
        .await
        .unwrap();
    store
        .set_visibility("team-chat", "team", Some("team-alpha"), true)
        .await
        .unwrap();

    // Same-org membership alone is not enough for a team-scoped row. The
    // compatibility wrapper intentionally passes no team ids, matching an
    // authenticated caller whose JWT predates team claims.
    assert!(store
        .list_conversations_visible_with_preview(Some("bob"), Some("org1"), true)
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .visible_conversation_ids(Some("bob"), Some("org1"), true)
        .await
        .unwrap()
        .is_empty());

    let team_ids = Some(r#"["team-alpha"]"#);
    let visible = store
        .list_conversations_visible_with_preview_for_teams(
            Some("bob"),
            Some("org1"),
            true,
            team_ids,
        )
        .await
        .unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(
        visible[0].last_message.as_deref(),
        Some("team-only roadmap")
    );
    assert_eq!(
        store
            .visible_conversation_ids_for_teams(Some("bob"), Some("org1"), true, team_ids)
            .await
            .unwrap(),
        vec!["team-chat".to_owned()]
    );
}

/// **The choke-point acceptance test** (task item 1).
///
/// Reads every production source of the store and asserts there is exactly ONE
/// `INSERT INTO conversations` — [`upsert_conversation_row`],
/// which always emits the tenancy clause. A future creation path that hand-rolls
/// its own INSERT (and therefore could forget to stamp an owner, locking that
/// owner out of their own chat on an org-bound node) fails HERE, in CI, rather
/// than silently in production.
#[test]
fn exactly_one_insert_into_conversations_in_the_whole_store() {
    // The tests live in their own files, so every production source is scanned
    // whole; `production_sources_cover_every_declared_part` keeps the list
    // complete.
    let production = production_sources()
        .into_iter()
        .map(|(_, source)| source)
        .collect::<Vec<_>>()
        .join("\n");
    // Matches every row-creating form, not just the one that exists today, so a
    // future `INSERT OR IGNORE` / `INSERT OR REPLACE` / `REPLACE INTO` cannot slip
    // a second, un-stamping creation path past this guard.
    let hits: Vec<&str> = production
        .lines()
        .map(str::trim)
        .filter(|l| {
            let l = l.trim_start_matches('"');
            (l.starts_with("INSERT") || l.starts_with("REPLACE"))
                && l.contains("INTO conversations")
        })
        .collect();
    assert_eq!(
        hits.len(),
        1,
        "every conversation row must be created by the ONE choke point \
             (upsert_conversation_row), which always stamps tenancy; found {} raw INSERTs: {hits:?}",
        hits.len()
    );
}

/// The choke point's tenancy clause must be preserve-not-clobber AND
/// first-writer-wins. Asserted on the SQL text so a future edit that flips a
/// COALESCE direction (which would either wipe a claimed owner — re-opening the
/// leak — or let a row be re-tenanted — enabling theft) fails loudly.
#[test]
fn the_choke_point_always_coalesces_tenancy() {
    let src = production_sources()
        .into_iter()
        .map(|(_, source)| source)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(src
        .contains("owner_user_id = COALESCE(conversations.owner_user_id, excluded.owner_user_id)"));
    assert!(src.contains("org_id        = COALESCE(conversations.org_id, excluded.org_id)"));
}

/// **ResourceKey regression (task C2, deliverable #1): behavior-preserving.**
///
/// The `ResourceKey` composition layer must lower to a `Tenancy` whose `parts()`
/// are byte-identical to the pre-ResourceKey construction, for every case the
/// choke point can see — including the load-bearing collapse (an unattributed
/// key yields `(None, None)`, the row an UNBOUND node writes, so no offline
/// lockout regresses). The compound `node`/`project`/`session` address composes
/// but never alters the emitted pair.
#[test]
fn resource_key_lowers_to_identical_tenancy_parts() {
    // Every (user, org) shape a caller can hand in — the derived Tenancy's
    // parts must equal the direct `owned_by` construction exactly.
    for (user, org) in [
        (Some("u1"), Some("acme")),
        (Some("u1"), None),
        (None, None),
        // org-only in ⇒ collapses to fully unattributed (the pair the SQL has
        // never seen is never produced).
        (None, Some("acme")),
    ] {
        let via_key = Tenancy::from_resource_key(&ResourceKey::owned(user, org));
        let direct = Tenancy::owned_by(user, org);
        assert_eq!(
            via_key.parts(),
            direct.parts(),
            "ResourceKey lowering must match owned_by for ({user:?}, {org:?})"
        );
    }

    // The UNBOUND-node row: an unattributed key is byte-identical to
    // `Tenancy::Unattributed` and writes `(None, None)` — the invariant that
    // keeps an offline/personal node from ever locking its owner out.
    let unbound = Tenancy::from_resource_key(&ResourceKey::unattributed());
    assert_eq!(unbound, Tenancy::Unattributed);
    assert_eq!(unbound.parts(), (None, None));

    // Compound address composes above the collapse but never changes the pair
    // the choke point stamps.
    let compound = ResourceKey::owned(Some("u1"), Some("acme"))
        .with_session(Some("conv-9"))
        .with_project(Some("/proj"));
    assert_eq!(
        Tenancy::from_resource_key(&compound).parts(),
        Tenancy::owned_by(Some("u1"), Some("acme")).parts()
    );

    // Round-trip: Tenancy → ResourceKey → Tenancy is stable.
    let t = Tenancy::Owned {
        user_id: "u1".into(),
        org_id: Some("acme".into()),
    };
    assert_eq!(Tenancy::from_resource_key(&t.to_resource_key()), t);
}

/// **Principal resolution with/without a host conversation id (task C2,
/// deliverable #2).** Locks the headline behavior the gateway-exec threading
/// rests on: an org-bound node resolves `Owned` from a tenanted host
/// conversation (the id the Gateway now forwards), fails closed to `Unresolved`
/// without one, and — the load-bearing no-lockout invariant — resolves
/// `Unrestricted` on an UNBOUND node regardless. `resolve_at` was previously
/// untested; this is the first assertion over it.
#[tokio::test]
async fn tool_principal_resolves_from_host_conversation() {
    use crate::sidecar::mcp::ToolPrincipal;
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation(
            "c1",
            None,
            None,
            Tenancy::Owned {
                user_id: "u1".into(),
                org_id: Some("acme".into()),
            },
        )
        .await
        .unwrap();

    // BOUND node + host conversation with an owner ⇒ Owned: the forwarded id
    // resolves the principal (the gateway-exec headline).
    assert!(matches!(
        ToolPrincipal::resolve_at(&store, Some("c1"), Some("acme")).await,
        ToolPrincipal::Owned { user_id, org_id }
            if user_id == "u1" && org_id.as_deref() == Some("acme")
    ));

    // BOUND node, NO host conversation ⇒ fail-closed Unresolved ("without id").
    assert_eq!(
        ToolPrincipal::resolve_at(&store, None, Some("acme")).await,
        ToolPrincipal::Unresolved
    );

    // BOUND node + host conversation that is itself untenanted ⇒ Unresolved
    // (no owner to attribute the tool call to; fail closed).
    store
        .ensure_conversation("c-null", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    assert_eq!(
        ToolPrincipal::resolve_at(&store, Some("c-null"), Some("acme")).await,
        ToolPrincipal::Unresolved
    );

    // UNBOUND node ⇒ Unrestricted regardless of the id — the invariant that
    // keeps a personal/offline node from ever locking its owner out.
    assert_eq!(
        ToolPrincipal::resolve_at(&store, Some("c1"), None).await,
        ToolPrincipal::Unrestricted
    );
    assert_eq!(
        ToolPrincipal::resolve_at(&store, None, None).await,
        ToolPrincipal::Unrestricted
    );
}

#[tokio::test]
async fn append_message_publishes_live_event_to_room() {
    // The make-or-break wiring: a store sharing the SAME registry instance a
    // viewer subscribes against must deliver a `message` Events frame on every
    // persisted turn, shaped to match the GET read path (plaintext content,
    // role, ids, created_at). This is the only way to catch a "wrong registry
    // instance" regression without a live WS client.
    let registry = ryu_realtime::RoomRegistry::new();
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_realtime(registry.clone());

    // A subscribed viewer makes the room live (publish is a no-op otherwise).
    let mut rx = registry.get_or_create("conv-live").subscribe();

    let id = store
        .append_message(
            "conv-live",
            "user",
            "hello live",
            None,
            Some("user-7"),
            None,
        )
        .await
        .unwrap();

    let frame = rx.recv().await.expect("frame delivered");
    // The message fan-out now rides the typed-event envelope
    // (`broadcast_event` → `Frame::Event({__ryu_event, data})`), so a raw
    // subscriber sees the payload nested under `data`. Decode it the way the
    // typed contract intends and assert against the payload.
    let event = ryu_realtime::Event::decode(&frame).expect("a typed Event frame");
    assert_eq!(event.name, "conversation.message");
    let value = &event.payload;
    assert_eq!(value["type"], "message");
    assert_eq!(value["conversation_id"], "conv-live");
    assert_eq!(value["message"]["id"], id);
    assert_eq!(value["message"]["role"], "user");
    assert_eq!(value["message"]["content"], "hello live");
    assert_eq!(value["message"]["author_user_id"], "user-7");
    assert!(value["message"]["created_at"].is_i64());
}

#[tokio::test]
async fn append_message_without_realtime_is_silent() {
    // Unwired store (tests/CLI) must persist exactly as before — no panic, no
    // dependency on a registry.
    let store = ConversationStore::open_in_memory().unwrap();
    let id = store
        .append_message("c-silent", "user", "hi", None, None, None)
        .await
        .unwrap();
    assert!(!id.is_empty());
}
