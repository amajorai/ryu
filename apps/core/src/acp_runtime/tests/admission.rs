//! Admission gate tests: eviction, queue order, and retiring chats.

use std::sync::atomic::Ordering;

use serde_json::json;

use super::ADMISSION_TEST_LOCK;
use crate::acp_runtime as runtime;
#[tokio::test]
async fn full_admission_evicts_one_idle_instance_instead_of_waiting_for_its_ttl() {
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 1 }));
    let idle_holder = runtime::acquire(|_| false).await;

    let holder = std::sync::Mutex::new(Some(idle_holder));
    let evictions = std::sync::atomic::AtomicU32::new(0);
    let permit = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runtime::acquire(|_| {
            evictions.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // Stand-in for an evicted instance exiting and releasing its slot.
            holder.lock().unwrap().take().is_some()
        }),
    )
    .await
    .expect("waiter admitted after eviction");

    assert_eq!(evictions.load(std::sync::atomic::Ordering::SeqCst), 1);
    drop(permit);
    runtime::apply_config(&json!({}));
}

/// Another waiter can take the slot an eviction freed. Once that eviction is
/// no longer in flight, the waiter that lost the race must evict again rather
/// than sit until some instance's idle TTL.
#[tokio::test]
async fn a_waiter_whose_freed_slot_was_taken_evicts_again() {
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 1 }));
    let busy_holder = runtime::acquire(|_| false).await;

    let holder = std::sync::Mutex::new(Some(busy_holder));
    let calls = std::sync::atomic::AtomicU32::new(0);
    let permit = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runtime::acquire(|_| {
            let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if call == 0 {
                // First eviction's slot goes to a thief: the evicted instance
                // finishes, but no permit is freed for this waiter.
                runtime::eviction_started();
                tokio::spawn(async {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    runtime::eviction_finished();
                });
                true
            } else {
                holder.lock().unwrap().take().is_some()
            }
        }),
    )
    .await
    .expect("waiter admitted after a second eviction");

    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    drop(permit);
    runtime::apply_config(&json!({}));
}

/// The only slot's holder is still busy when a turn queues, so nothing can
/// be evicted yet. When the holder goes idle, `instance_idle` must wake the
/// waiter to evict it, well before the backstop re-check or the idle TTL.
#[tokio::test]
async fn a_holder_going_idle_wakes_a_queued_turn_to_evict_it() {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;

    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 1 }));
    let busy_holder = runtime::acquire(|_| false).await;

    // Stand-in for the holder's instance task: once evicted it reports the
    // finish and then releases its permit, in production order.
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let holder_task = tokio::spawn(async move {
        let _ = release_rx.await;
        runtime::eviction_finished();
        drop(busy_holder);
    });

    let holder_idle = Arc::new(AtomicBool::new(false));
    let evictions = Arc::new(AtomicU32::new(0));
    let waiter = tokio::spawn({
        let holder_idle = Arc::clone(&holder_idle);
        let evictions = Arc::clone(&evictions);
        let mut release_tx = Some(release_tx);
        async move {
            runtime::acquire(move |_| {
                if !holder_idle.load(Ordering::SeqCst) {
                    return false;
                }
                let Some(release) = release_tx.take() else {
                    return false;
                };
                evictions.fetch_add(1, Ordering::SeqCst);
                runtime::eviction_started();
                let _ = release.send(());
                true
            })
            .await
        }
    });

    // Let the waiter find the slot busy and park.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!waiter.is_finished(), "waiter queued behind a busy holder");

    holder_idle.store(true, Ordering::SeqCst);
    runtime::instance_idle();
    let permit = tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
        .await
        .expect("idle holder wakes the queued turn")
        .expect("waiter task");

    assert_eq!(evictions.load(Ordering::SeqCst), 1);
    holder_task.await.expect("holder task");
    drop(permit);
    runtime::apply_config(&json!({}));
}

/// Turns are admitted in arrival order: a slot that frees goes to the
/// longest-waiting turn, never to one that arrived later.
#[tokio::test]
async fn queued_turns_are_admitted_first_come_first_served() {
    use std::sync::{Arc, Mutex as StdMutex};
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 1 }));
    let holder = runtime::acquire(|_| false).await;

    let order = Arc::new(StdMutex::new(Vec::new()));
    let mut waiters = Vec::new();
    for name in ["first", "second", "third"] {
        let order = Arc::clone(&order);
        waiters.push(tokio::spawn(async move {
            let permit = runtime::acquire(|_| false).await;
            order.lock().unwrap().push(name);
            // Hold the slot briefly so the next turn must wait for it.
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            drop(permit);
        }));
        // Let each waiter take its place in line before the next arrives.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    drop(holder);
    for waiter in waiters {
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("every queued turn is admitted")
            .expect("waiter task");
    }
    assert_eq!(*order.lock().unwrap(), vec!["first", "second", "third"]);
    runtime::apply_config(&json!({}));
}

/// A chat replacing its own retired instance waits at the front of the line
/// for that instance's slot, ahead of turns that queued earlier.
#[tokio::test]
async fn a_retiring_chat_takes_its_own_slot_ahead_of_the_queue() {
    use std::sync::{Arc, Mutex as StdMutex};
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 1 }));
    let mut holder = runtime::acquire(|_| false).await;
    let evicted = runtime::EvictionFlag::default();
    holder.track_eviction(evicted.clone());

    let order = Arc::new(StdMutex::new(Vec::new()));
    let earlier = tokio::spawn({
        let order = Arc::clone(&order);
        async move {
            let permit = runtime::acquire(|_| false).await;
            order.lock().unwrap().push("earlier");
            drop(permit);
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    assert!(runtime::start_eviction(&evicted));
    let replacement = tokio::spawn({
        let order = Arc::clone(&order);
        async move {
            let permit = runtime::acquire_after_retiring(|_| {
                panic!("a retiring chat waits for its own slot")
            })
            .await;
            order.lock().unwrap().push("replacement");
            drop(permit);
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    drop(holder);
    for task in [replacement, earlier] {
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("both turns are admitted")
            .expect("task");
    }
    assert_eq!(*order.lock().unwrap(), vec!["replacement", "earlier"]);
    assert_eq!(runtime::evictions_in_flight(), 0);
    runtime::apply_config(&json!({}));
}

/// A queued turn first asks only for instances idle past the grace, and
/// after waiting long enough for any idle instance.
#[tokio::test(start_paused = true)]
async fn a_queued_turn_spares_just_idled_instances_until_it_has_waited() {
    use std::sync::{Arc, Mutex as StdMutex};
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 1 }));
    let holder = Arc::new(StdMutex::new(Some(runtime::acquire(|_| false).await)));
    let asked = Arc::new(StdMutex::new(Vec::new()));
    let waiter = tokio::spawn({
        let holder = Arc::clone(&holder);
        let asked = Arc::clone(&asked);
        async move {
            runtime::acquire(move |min_idle| {
                asked.lock().unwrap().push(min_idle);
                // The only idle instance went idle just now: evictable only
                // once the caller stops requiring the grace.
                min_idle.is_zero() && holder.lock().unwrap().take().is_some()
            })
            .await
        }
    });
    // One slot: a one-second grace, any idle instance after two seconds.
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    let permit = tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
        .await
        .expect("the turn is admitted after waiting")
        .expect("waiter task");
    let asked = asked.lock().unwrap().clone();
    assert_eq!(asked.first(), Some(&std::time::Duration::from_secs(1)));
    assert_eq!(asked.last(), Some(&std::time::Duration::ZERO));
    assert!(asked.len() >= 2, "{asked:?}");
    drop(permit);
    runtime::apply_config(&json!({}));
}

/// A turn that gives up while queued leaves the line, so the turn behind it
/// is not blocked.
#[tokio::test]
async fn a_cancelled_queued_turn_does_not_block_the_next() {
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 1 }));
    let holder = runtime::acquire(|_| false).await;
    let cancelled = tokio::spawn(runtime::acquire(|_| false));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let next = tokio::spawn(runtime::acquire(|_| false));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    cancelled.abort();
    let _ = cancelled.await;
    drop(holder);
    let permit = tokio::time::timeout(std::time::Duration::from_secs(2), next)
        .await
        .expect("the next turn is admitted")
        .expect("waiter task");
    drop(permit);
    runtime::apply_config(&json!({}));
}

/// An evicted instance returns its slot and ends its eviction together, so
/// the waiter it was evicted for never sees the eviction over while the slot
/// is still held, and never evicts a second instance.
#[tokio::test]
async fn an_evicted_slot_and_its_eviction_end_together() {
    use std::sync::atomic::AtomicU32;
    use std::sync::Arc;
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 1 }));
    let mut holder = runtime::acquire(|_| false).await;
    let evicted = runtime::EvictionFlag::default();
    holder.track_eviction(evicted.clone());
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let instance = tokio::spawn(async move {
        let _ = release_rx.await;
        // Teardown takes a moment after the eviction is observed.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        drop(holder);
    });
    let calls = Arc::new(AtomicU32::new(0));
    let mut release_tx = Some(release_tx);
    let permit = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runtime::acquire({
            let calls = Arc::clone(&calls);
            move |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                let Some(release) = release_tx.take() else {
                    return false;
                };
                assert!(runtime::start_eviction(&evicted));
                let _ = release.send(());
                true
            }
        }),
    )
    .await
    .expect("the waiter takes the evicted slot");
    instance.await.expect("instance task");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "no second eviction");
    assert_eq!(runtime::evictions_in_flight(), 0);
    drop(permit);
    runtime::apply_config(&json!({}));
}

/// An instance that returned its slot on its own (idle TTL, crash) between
/// being picked and being evicted is not counted in flight, so no waiter
/// waits for a slot that will not come.
#[tokio::test]
async fn evicting_an_instance_whose_slot_is_back_counts_nothing() {
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 1 }));
    let mut holder = runtime::acquire(|_| false).await;
    let eviction = runtime::EvictionFlag::default();
    holder.track_eviction(eviction.clone());
    drop(holder);
    assert!(!runtime::start_eviction(&eviction));
    assert!(!eviction.is_evicted());
    assert_eq!(runtime::evictions_in_flight(), 0);
    // And a second eviction of a live instance is not counted twice.
    let mut holder = runtime::acquire(|_| false).await;
    let eviction = runtime::EvictionFlag::default();
    holder.track_eviction(eviction.clone());
    assert!(runtime::start_eviction(&eviction));
    assert!(!runtime::start_eviction(&eviction));
    assert_eq!(runtime::evictions_in_flight(), 1);
    drop(holder);
    assert_eq!(runtime::evictions_in_flight(), 0);
    runtime::apply_config(&json!({}));
}

/// A waiter whose freed slot was taken by a retiring chat ahead of it evicts
/// again as soon as its own eviction is over, without waiting for that
/// chat's retired instance to finish a long turn.
#[tokio::test]
async fn a_waiter_does_not_wait_on_evictions_that_started_after_its_own() {
    use std::sync::atomic::AtomicU32;
    use std::sync::{Arc, Mutex as StdMutex};
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    runtime::apply_config(&json!({ "max_parallel_agents": 3 }));
    // `busy` is mid-turn in a chat that will retire it; `idle` is evicted
    // first; `spare` is another idle instance the waiter may take next.
    let mut busy = runtime::acquire(|_| false).await;
    let busy_eviction = runtime::EvictionFlag::default();
    busy.track_eviction(busy_eviction.clone());
    let mut idle = runtime::acquire(|_| false).await;
    let idle_eviction = runtime::EvictionFlag::default();
    idle.track_eviction(idle_eviction.clone());
    let spare = Arc::new(StdMutex::new(Some(runtime::acquire(|_| false).await)));

    let calls = Arc::new(AtomicU32::new(0));
    let waiter = tokio::spawn({
        let calls = Arc::clone(&calls);
        let spare = Arc::clone(&spare);
        async move {
            runtime::acquire(move |_| match calls.fetch_add(1, Ordering::SeqCst) {
                0 => runtime::start_eviction(&idle_eviction),
                _ => spare.lock().unwrap().take().is_some(),
            })
            .await
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // The busy chat retires its instance; the replacement queues in front.
    assert!(runtime::start_eviction(&busy_eviction));
    let replacement = tokio::spawn(runtime::acquire_after_retiring(|_| false));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    // The evicted instance exits. Whichever of the two takes its slot, the
    // other gets one too: the waiter evicts the spare without waiting for
    // the busy instance's turn to end.
    drop(idle);
    let replacement = tokio::time::timeout(std::time::Duration::from_secs(3), replacement)
        .await
        .expect("the replacement is admitted")
        .expect("replacement task");
    let permit = tokio::time::timeout(std::time::Duration::from_secs(3), waiter)
        .await
        .expect("the waiter evicts again while the retirement is in flight")
        .expect("waiter task");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    drop(permit);
    drop(replacement);
    drop(busy);
    runtime::apply_config(&json!({}));
}

#[test]
fn the_eviction_grace_grows_with_the_slots_up_to_a_ceiling() {
    use std::time::Duration;
    assert_eq!(runtime::eviction_grace(0), Duration::from_secs(1));
    assert_eq!(runtime::eviction_grace(1), Duration::from_secs(1));
    assert_eq!(runtime::eviction_grace(4), Duration::from_secs(4));
    assert_eq!(runtime::eviction_grace(16), Duration::from_secs(15));
    assert_eq!(runtime::eviction_grace(32), Duration::from_secs(15));
    // A queued turn spares recently idle instances for twice the grace.
    assert_eq!(
        runtime::eviction_min_idle(Duration::from_secs(29), 16),
        Duration::from_secs(15)
    );
    assert_eq!(
        runtime::eviction_min_idle(Duration::from_secs(30), 16),
        Duration::ZERO
    );
    assert_eq!(
        runtime::eviction_min_idle(Duration::from_secs(2), 1),
        Duration::ZERO
    );
}
