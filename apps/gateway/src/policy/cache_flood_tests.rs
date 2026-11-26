//! Tests of the token resolve cache (`super`) under a flood of unknown
//! bearers (security finding GW-1). The Gateway HTTP mapping of a busy resolve
//! to 429 and an unresolved one to 401 is tested in `cache_tests.rs`.

use super::tests::mock_control_plane;
use super::*;

#[tokio::test]
async fn a_flood_of_unknown_tokens_does_not_lock_out_a_known_tenant() {
    use std::sync::atomic::Ordering;
    let (cache, calls, gate, server) = mock_control_plane().await;
    let cache = Arc::new(cache);
    assert!(cache.resolve_cached("rgw_good_tenant").await.is_ok());
    // The tenant's entry expires, so its next request has to resolve again.
    cache.age_entries_for_test(POSITIVE_TTL + Duration::from_secs(1));
    // Twice as many made-up tokens as there are shared permits. The control
    // plane does not answer them yet, so each admitted one holds its permit.
    let flood: Vec<_> = (0..2 * MAX_CONCURRENT_RESOLVES)
        .map(|i| {
            let cache = cache.clone();
            tokio::spawn(async move { cache.resolve_cached(&format!("rgw_wait_flood_{i}")).await })
        })
        .collect();
    tokio::time::timeout(Duration::from_secs(5), async {
        while calls.load(Ordering::SeqCst) < 1 + MAX_CONCURRENT_RESOLVES {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(cache.admission.available_permits(), 0);
    assert_eq!(cache.reserved.available_permits(), RESERVED_RESOLVES);

    let tenant = tokio::time::timeout(
        Duration::from_secs(2),
        cache.resolve_cached("rgw_good_tenant"),
    )
    .await
    .expect("the known tenant's resolve finishes within the bound");
    let tenant = tenant.expect("a known tenant still resolves while the flood holds the gate");
    assert_eq!(tenant.org_id, "org_test");

    // The reserve is only for keys that resolved before: made-up tokens and a
    // valid token this instance has never seen still get a retryable 429.
    assert!(matches!(
        cache.resolve_cached("rgw_wait_more").await,
        Err(ResolveErr::Busy)
    ));
    assert!(matches!(
        cache.resolve_cached("rgw_good_never_seen").await,
        Err(ResolveErr::Busy)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2 + MAX_CONCURRENT_RESOLVES);
    assert_eq!(cache.reserved.available_permits(), RESERVED_RESOLVES);

    gate.add_permits(4 * MAX_CONCURRENT_RESOLVES);
    for task in flood {
        assert!(task.await.unwrap().is_err());
    }
    assert_eq!(cache.admission.available_permits(), MAX_CONCURRENT_RESOLVES);
    server.abort();
}

#[tokio::test]
async fn a_full_map_evicts_made_up_tokens_before_a_tenants_valid_entry() {
    use std::sync::atomic::Ordering;
    let (cache, calls, _, server) = mock_control_plane().await;
    assert!(cache.resolve_cached("rgw_good_keep").await.is_ok());
    // Make the tenant's entry the oldest one, still well inside its TTL.
    cache.age_entries_for_test(Duration::from_secs(1));
    {
        let mut state = cache.state.lock().unwrap();
        let now = Instant::now();
        for i in 0..MAX_ENTRIES - 1 {
            state.entries.insert(
                format!("gateway.inference:rgw_fake_{i}"),
                CachedResolve {
                    resolved: Err(()),
                    fetched_at: now,
                },
            );
        }
        assert_eq!(state.entries.len(), MAX_ENTRIES);
    }
    assert!(cache.resolve_cached("rgw_bad_new").await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(cache.state.lock().unwrap().entries.len() <= MAX_ENTRIES);
    // Served from the cache: the tenant's entry was not the one evicted.
    assert!(cache.resolve_cached("rgw_good_keep").await.is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    server.abort();
}

#[test]
fn known_good_marks_stay_bounded_and_drop_the_oldest() {
    let start = Instant::now();
    let mut known = HashMap::new();
    for i in 0..MAX_ENTRIES {
        remember_known_good(
            &mut known,
            &format!("k{i}"),
            start + Duration::from_millis(i as u64),
        );
    }
    remember_known_good(&mut known, "k0", start + Duration::from_secs(3600));
    assert_eq!(known.len(), MAX_ENTRIES);
    remember_known_good(&mut known, "new", start + Duration::from_secs(7200));
    assert_eq!(known.len(), MAX_ENTRIES);
    assert!(
        known.contains_key("k0"),
        "a refreshed mark is not the oldest"
    );
    assert!(!known.contains_key("k1"), "the oldest mark is dropped");
    assert!(known.contains_key("new"));
}
