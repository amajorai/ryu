//! Per-caller memory visibility: ResourceKey derivation and org-scope tenancy.

use super::*;

/// **ResourceKey regression (task C2, deliverable #1): behavior-preserving.**
///
/// The memory plane derives its owning user from a `ResourceKey` and its read
/// filter from one, both byte-identical to the pre-ResourceKey values —
/// including the two load-bearing no-ops: an unattributed key maps to the
/// `LOCAL_USER` sentinel (the exact value the write path used), and an UNBOUND
/// node (`node_bound = false`) disables filtering regardless of the key.
#[test]
fn resource_key_memory_derivation_is_behavior_preserving() {
    // Owning user: attributed ⇒ the user; unattributed ⇒ the LOCAL_USER
    // sentinel, unchanged from the pre-ResourceKey write path.
    assert_eq!(
        memory_user_from_key(&ResourceKey::owned(Some("u1"), None)),
        "u1"
    );
    assert_eq!(
        memory_user_from_key(&ResourceKey::unattributed()),
        LOCAL_USER
    );
    // Memory has no org, so an org-only key still collapses to LOCAL_USER.
    assert_eq!(
        memory_user_from_key(&ResourceKey::owned(None, Some("acme"))),
        LOCAL_USER
    );

    // Read filter: on a BOUND node the caller user is carried through exactly
    // like `for_caller`.
    let bound_key = ResourceKey::owned(Some("u1"), None);
    let bound = MemoryVisibility::from_resource_key(&bound_key, true);
    assert!(bound.node_bound);
    assert_eq!(bound.caller_user_id, Some("u1"));

    // UNBOUND node: filtering is a total no-op regardless of the key — the
    // invariant that keeps a personal node from filtering itself out.
    let key = ResourceKey::owned(Some("u1"), Some("acme"));
    let unbound = MemoryVisibility::from_resource_key(&key, false);
    assert!(!unbound.node_bound);
    assert_eq!(
        unbound.node_bound,
        MemoryVisibility::unrestricted().node_bound
    );
}

/// Per-caller tenancy (the `MEMORY_VISIBLE_PREDICATE`): on a bound node a
/// `user`-scope fact is private to its owner while `node`/`project` facts stay
/// shared. Driven with `MemoryVisibility::for_caller(node_bound = true)` so no
/// org registration is needed (the caller tenancy is passed IN).
/// Build an org-scope fact belonging to org `org`.
fn org_fact(org: &str, content: &str) -> NewMemory {
    let mut m = NewMemory::user_fact(content);
    m.scope = MemoryScope::Org;
    m.scope_id = Some(org.to_owned());
    m
}

#[tokio::test]
async fn org_memory_is_visible_only_inside_its_own_org() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record_full("alice", "a", org_fact("acme", "acme roadmap"))
        .await
        .unwrap();
    store
        .record_full("zoe", "a", org_fact("initech", "initech roadmap"))
        .await
        .unwrap();
    let filter = MemoryFilter::default();

    // A member of acme sees acme's fact and NOT initech's — even though the
    // initech fact is owned by a different user entirely, the gate is the org.
    let acme = store
        .list_visible(
            &filter,
            MemoryVisibility::for_caller_in_org(Some("bob"), Some("acme"), true),
        )
        .await
        .unwrap();
    let contents: Vec<&str> = acme.iter().map(|e| e.content.as_str()).collect();
    assert!(contents.contains(&"acme roadmap"));
    assert!(
        !contents.contains(&"initech roadmap"),
        "org memory must not leak across orgs"
    );
}

#[tokio::test]
async fn org_memory_fails_closed_without_a_caller_org() {
    // The regression that matters: a caller with no org on a BOUND node must see
    // no org facts at all, rather than falling through to a permissive branch.
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record_full("alice", "a", org_fact("acme", "acme roadmap"))
        .await
        .unwrap();

    let orgless = store
        .list_visible(
            &MemoryFilter::default(),
            MemoryVisibility::for_caller(Some("bob"), true),
        )
        .await
        .unwrap();
    assert!(
        orgless.iter().all(|e| e.content != "acme roadmap"),
        "a caller with no org must not read org memory"
    );
}

#[tokio::test]
async fn org_memory_is_visible_on_an_unbound_personal_node() {
    // On an unbound node there is exactly one principal and the node token is the
    // boundary, so nothing is filtered — including org rows. Without this the
    // owner of a personal node could be locked out of their own data.
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record_full("alice", "a", org_fact("acme", "acme roadmap"))
        .await
        .unwrap();
    let all = store
        .list_visible(&MemoryFilter::default(), MemoryVisibility::unrestricted())
        .await
        .unwrap();
    assert!(all.iter().any(|e| e.content == "acme roadmap"));
}
