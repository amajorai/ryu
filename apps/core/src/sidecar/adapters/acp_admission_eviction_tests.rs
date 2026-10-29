use super::{lru_idle_pool_key, AcpInstanceActivity, AcpPoolEntry};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use tokio::sync::mpsc;

fn entry(admitted: bool, idle_since: Option<u64>) -> AcpPoolEntry {
    let (turns, turns_rx) = mpsc::unbounded_channel();
    // Keep the receiver alive so the sender is not closed.
    std::mem::forget(turns_rx);
    let activity = AcpInstanceActivity::new();
    if admitted {
        activity.mark_admitted();
    }
    if let Some(since) = idle_since {
        activity.mark_idle();
        activity.idle_since_ms.store(since, Ordering::Release);
    }
    AcpPoolEntry {
        turns,
        capability_session_id: None,
        inference_grant_id: None,
        activity,
    }
}

#[test]
fn eviction_picks_the_oldest_idle_admitted_instance_only() {
    let mut pool = HashMap::new();
    pool.insert("busy".to_owned(), entry(true, None));
    pool.insert("waiting-for-permit".to_owned(), entry(false, Some(1)));
    pool.insert("idle-new".to_owned(), entry(true, Some(300)));
    pool.insert("idle-old".to_owned(), entry(true, Some(200)));
    assert_eq!(
        lru_idle_pool_key(pool.iter(), u64::MAX).as_deref(),
        Some("idle-old")
    );

    pool.remove("idle-old");
    pool.remove("idle-new");
    assert_eq!(lru_idle_pool_key(pool.iter(), u64::MAX), None);
}

#[test]
fn a_recent_eviction_is_reported_once_and_the_record_stays_bounded() {
    let mut recent = std::collections::VecDeque::new();
    super::record_eviction(&mut recent, "a");
    super::record_eviction(&mut recent, "a");
    assert_eq!(recent.len(), 1);
    assert!(super::take_eviction(&mut recent, "a"));
    assert!(!super::take_eviction(&mut recent, "a"));
    for index in 0..super::RECENT_EVICTIONS_KEPT + 10 {
        super::record_eviction(&mut recent, &index.to_string());
    }
    assert_eq!(recent.len(), super::RECENT_EVICTIONS_KEPT);
    assert!(!super::take_eviction(&mut recent, "0"));
    assert!(super::take_eviction(
        &mut recent,
        &(super::RECENT_EVICTIONS_KEPT + 9).to_string()
    ));
}

/// An instance that went idle within the grace is not evicted for a queued
/// turn; its chat is likely to send the next message right away.
#[test]
fn eviction_skips_instances_idle_for_less_than_the_grace() {
    let mut pool = HashMap::new();
    pool.insert("just-idled".to_owned(), entry(true, Some(10_000)));
    pool.insert("idle-a-while".to_owned(), entry(true, Some(4_000)));
    // Only instances idle since 5_000 or earlier qualify.
    assert_eq!(
        lru_idle_pool_key(pool.iter(), 5_000).as_deref(),
        Some("idle-a-while")
    );
    pool.remove("idle-a-while");
    assert_eq!(lru_idle_pool_key(pool.iter(), 5_000), None);
    // A turn that has waited past the grace may take the just-idled one.
    assert_eq!(
        lru_idle_pool_key(pool.iter(), 10_000).as_deref(),
        Some("just-idled")
    );
}

#[test]
fn a_closed_instance_is_not_an_eviction_candidate() {
    let (turns, turns_rx) = mpsc::unbounded_channel();
    drop(turns_rx);
    let activity = AcpInstanceActivity::new();
    activity.mark_admitted();
    activity.mark_idle();
    let mut pool = HashMap::new();
    pool.insert(
        "closed".to_owned(),
        AcpPoolEntry {
            turns,
            capability_session_id: None,
            inference_grant_id: None,
            activity,
        },
    );
    assert_eq!(lru_idle_pool_key(pool.iter(), u64::MAX), None);
}
