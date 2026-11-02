use super::*;

#[tokio::test]
async fn expired_pending_codes_are_pruned_and_pending_codes_are_bounded() {
    let store = PairingStore::ephemeral();
    let policy = AccessPolicy::default();
    store.challenge("telegram", "u-old").await;
    age_pending(&store, "telegram", "u-old").await;
    store.block("telegram", "u-blocked").await;
    store.approve("telegram", "u-paired").await;

    assert!(matches!(
        store.challenge("telegram", "u-new").await,
        Decision::Challenge(_)
    ));
    assert_eq!(store.get("telegram", "u-old").await, None);
    assert_eq!(
        store.get("telegram", "u-blocked").await,
        Some(PairState::Blocked)
    );
    assert!(matches!(
        store.get("telegram", "u-paired").await,
        Some(PairState::Paired { .. })
    ));

    // Fill the queue with live codes ("u-new" already holds one).
    for index in 1..MAX_PENDING_PAIRINGS {
        assert!(matches!(
            store.challenge("telegram", &format!("u-{index}")).await,
            Decision::Challenge(_)
        ));
    }
    let entries_when_full = store.inner.read().await.entries.len();
    assert_eq!(
        store.challenge("telegram", "u-fresh").await,
        Decision::Deny,
        "a full queue fails closed for unknown senders"
    );
    assert_eq!(store.inner.read().await.entries.len(), entries_when_full);

    // Senders who already have a code, or are paired, are unaffected.
    let Some(PairState::Pending { code, .. }) = store.get("telegram", "u-new").await else {
        panic!("u-new should still be pending");
    };
    assert_eq!(
        store.challenge("telegram", "u-new").await,
        Decision::Pending(code)
    );
    assert_eq!(
        policy.decide_dm(&store, "telegram", "u-paired").await,
        Decision::Allow
    );

    // Once a code expires, a new sender can enrol again.
    age_pending(&store, "telegram", "u-1").await;
    assert!(matches!(
        store.challenge("telegram", "u-fresh").await,
        Decision::Challenge(_)
    ));
    assert_eq!(store.get("telegram", "u-1").await, None);
}
