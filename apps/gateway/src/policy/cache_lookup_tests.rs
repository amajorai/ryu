//! Lookup tests for the token resolve cache: a hit tests only its own key, and
//! a stale or superseded entry for the requested key is still never served.

use std::sync::atomic::Ordering;

use super::tests::{mock_control_plane, sample_org};
use super::*;
use crate::standing::EnforcementPush;

fn key_of(token: &str) -> String {
    format!("{}:{token}", CredentialUse::GatewayRelay.operation())
}

fn org_named(org_id: &str) -> Arc<ResolvedOrg> {
    let mut org = (*sample_org()).clone();
    org.org_id = org_id.to_owned();
    Arc::new(org)
}

fn put(cache: &ResolveCache, token: &str, org: Arc<ResolvedOrg>, age: Duration) {
    let fetched_at = Instant::now().checked_sub(age).unwrap();
    cache.state.lock().unwrap().entries.insert(
        key_of(token),
        CachedResolve {
            resolved: Ok(org),
            fetched_at,
        },
    );
}

fn org_push(org_id: &str, version: u64) -> EnforcementPush {
    EnforcementPush {
        org_id: Some(org_id.to_owned()),
        version,
        ..Default::default()
    }
}

fn offline_cache() -> ResolveCache {
    // A hit never reaches the control plane, so the address is never dialled.
    ResolveCache::for_test("http://127.0.0.1:9".to_owned(), reqwest::Client::new())
}

#[tokio::test]
async fn a_hit_serves_its_entry_and_leaves_every_other_entry_alone() {
    let cache = offline_cache();
    let stale = POSITIVE_TTL + Duration::from_secs(1);
    for i in 0..MAX_ENTRIES - 1 {
        put(
            &cache,
            &format!("rgw_idle_{i}"),
            org_named("org_idle"),
            stale,
        );
    }
    put(&cache, "rgw_live", org_named("org_live"), Duration::ZERO);
    let resolved = cache.resolve_cached("rgw_live").await.unwrap();
    assert_eq!(resolved.org_id, "org_live");
    // The idle entries are stale, and the hit did not walk them.
    assert_eq!(cache.state.lock().unwrap().entries.len(), MAX_ENTRIES);
    assert_eq!(cache.evict_expired(), MAX_ENTRIES - 1);
    assert_eq!(cache.state.lock().unwrap().entries.len(), 1);
    assert!(cache.resolve_cached("rgw_live").await.is_ok());
}

#[tokio::test]
async fn a_stale_entry_for_the_requested_key_is_not_served() {
    let (cache, calls, _, server) = mock_control_plane().await;
    // The control plane now refuses this token; the cached grant is expired.
    put(
        &cache,
        "rgw_bad_expired",
        org_named("org_test"),
        POSITIVE_TTL + Duration::from_secs(1),
    );
    assert_eq!(
        cache.resolve_cached("rgw_bad_expired").await.unwrap_err(),
        ResolveErr::Unresolved
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let state = cache.state.lock().unwrap();
    assert!(state.entries[&key_of("rgw_bad_expired")].resolved.is_err());
    drop(state);
    server.abort();
}

#[tokio::test]
async fn a_superseded_entry_for_the_requested_key_is_not_served() {
    let (cache, calls, _, server) = mock_control_plane().await;
    // Fresh by TTL, but fetched before a push that names its org: the push
    // reached the ledger while the entry's fetch was in flight.
    put(
        &cache,
        "rgw_bad_pushed",
        org_named("org_test"),
        Duration::ZERO,
    );
    put(&cache, "rgw_other", org_named("org_other"), Duration::ZERO);
    assert!(cache.enforcement_ledger().apply(&org_push("org_test", 1)));
    assert_eq!(
        cache.resolve_cached("rgw_bad_pushed").await.unwrap_err(),
        ResolveErr::Unresolved
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // A subject the push does not name keeps its entry, with no fetch.
    assert_eq!(
        cache.resolve_cached("rgw_other").await.unwrap().org_id,
        "org_other"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
}

#[test]
fn evict_expired_drops_exactly_what_a_lookup_would_refuse() {
    let cache = offline_cache();
    put(&cache, "rgw_fresh", org_named("org_a"), Duration::ZERO);
    put(
        &cache,
        "rgw_stale",
        org_named("org_a"),
        POSITIVE_TTL + Duration::from_secs(1),
    );
    put(&cache, "rgw_pushed", org_named("org_b"), Duration::ZERO);
    assert!(cache.enforcement_ledger().apply(&org_push("org_b", 4)));
    assert_eq!(cache.evict_expired(), 2);
    let state = cache.state.lock().unwrap();
    assert_eq!(state.entries.len(), 1);
    assert!(state.entries.contains_key(&key_of("rgw_fresh")));
}

/// Measures a hit against the full sweep the lookup used to run on every
/// request (`evict_expired` is that sweep). Run with `--nocapture` for the
/// numbers; the assertion only pins that a hit is cheaper than a sweep.
#[tokio::test]
async fn a_hit_on_a_full_cache_costs_less_than_one_sweep() {
    let cache = offline_cache();
    for i in 0..MAX_ENTRIES {
        put(
            &cache,
            &format!("rgw_t_{i}"),
            org_named(&format!("org_{i}")),
            Duration::ZERO,
        );
    }
    // One applied push makes the ledger take its slow path, as on a fleet
    // replica that has ever received an enforcement push.
    assert!(cache
        .enforcement_ledger()
        .apply(&org_push("org_elsewhere", 1)));
    const ROUNDS: u32 = 200;
    let started = Instant::now();
    for _ in 0..ROUNDS {
        assert_eq!(cache.evict_expired(), 0);
    }
    let sweep = started.elapsed() / ROUNDS;
    let started = Instant::now();
    for round in 0..ROUNDS {
        let token = format!("rgw_t_{}", round as usize % MAX_ENTRIES);
        assert!(cache.resolve_cached(&token).await.is_ok());
    }
    let hit = started.elapsed() / ROUNDS;
    println!(
        "resolve cache at {MAX_ENTRIES} entries: sweep {sweep:?} per call, hit {hit:?} per call"
    );
    assert!(
        hit < sweep,
        "hit {hit:?} should be cheaper than sweep {sweep:?}"
    );
}
