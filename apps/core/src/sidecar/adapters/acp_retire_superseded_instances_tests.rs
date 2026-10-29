use super::{
    changed_pool_key_components, retire_superseded_instances, AcpInstanceActivity, AcpPoolEntry,
    SupersededInstances,
};
use std::collections::HashMap;
use tokio::sync::mpsc;

fn entry() -> (AcpPoolEntry, mpsc::UnboundedReceiver<super::AcpTurn>) {
    let (turns, turns_rx) = mpsc::unbounded_channel();
    (
        AcpPoolEntry {
            turns,
            capability_session_id: None,
            inference_grant_id: None,
            activity: AcpInstanceActivity::new(),
        },
        turns_rx,
    )
}

#[test]
fn a_new_instance_retires_only_its_own_conversation_and_agent() {
    let mut pool = HashMap::new();
    let mut receivers = HashMap::new();
    for key in [
        "conv\u{1}ryu\u{1}spawn-new\u{1}/w",
        "conv\u{1}ryu\u{1}spawn-old\u{1}/w",
        "conv\u{1}ryu\u{1}spawn-older\u{1}/w",
        "conv\u{1}ryu-other\u{1}spawn-old\u{1}/w",
        "conv\u{1}custom\u{1}spawn-old\u{1}/w",
        "conv-b\u{1}ryu\u{1}spawn-old\u{1}/w",
    ] {
        let (pooled, turns_rx) = entry();
        pool.insert(key.to_owned(), pooled);
        receivers.insert(key, turns_rx);
    }
    let target = "conv\u{1}ryu\u{1}spawn-new\u{1}/w";

    // None of these was admitted, so no slot is reported as coming back.
    assert_eq!(
        retire_superseded_instances(&mut pool, "conv", "ryu", target),
        SupersededInstances {
            retired: 2,
            released_slot: false,
            changed: vec!["spawn_cmd"],
        }
    );
    // A retired instance sees its turn queue end; everything else stays live.
    for (key, turns_rx) in &receivers {
        let retired = key.starts_with("conv\u{1}ryu\u{1}spawn-old");
        assert_eq!(turns_rx.is_closed(), retired, "{key:?}");
        assert_eq!(pool.contains_key(*key), !retired, "{key:?}");
    }
    assert_eq!(
        retire_superseded_instances(&mut pool, "conv", "ryu", target).retired,
        0
    );
    // Ambiguous or unpooled ids never match by prefix.
    assert_eq!(
        retire_superseded_instances(&mut pool, "", "ryu", target).retired,
        0
    );
    assert_eq!(
        retire_superseded_instances(&mut pool, "conv\u{1}ryu", "spawn-new", "x").retired,
        0
    );
    assert_eq!(pool.len(), 4);
}

#[test]
fn a_changed_pool_key_names_only_the_components_that_differ() {
    let old = "conv\u{1}ryu\u{1}pi\u{1}/w\u{1}\u{1}A=1\u{1}{}\u{1}g1\u{1}workspace-trusted";
    let new = "conv\u{1}ryu\u{1}pi\u{1}/w\u{1}\u{1}A=2\u{1}{}\u{1}g2\u{1}workspace-trusted";
    assert_eq!(
        changed_pool_key_components(old, new),
        vec!["environment", "conversation_generation"]
    );
    assert!(changed_pool_key_components(old, old).is_empty());
    assert_eq!(changed_pool_key_components(old, "conv"), vec!["shape"]);
}

/// A conversation whose key changed retires its admitted instance; the
/// replacement takes that instance's slot instead of evicting another chat.
#[tokio::test]
async fn retiring_an_admitted_instance_hands_its_slot_to_the_replacement() {
    use crate::acp_runtime::tests::{apply_test_config, ADMISSION_TEST_LOCK};
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    apply_test_config(&serde_json::json!({ "max_parallel_agents": 1 }));

    let mut permit = crate::acp_runtime::acquire(|_| false).await;
    let (pooled, mut turns_rx) = entry();
    permit.track_eviction(pooled.activity.evicted.clone());
    pooled.activity.mark_admitted();
    // Stand-in for the retired instance task: it drains its queue, then
    // returns its slot, which ends the eviction, like the production task.
    let instance = tokio::spawn(async move {
        let _permit = permit;
        while turns_rx.recv().await.is_some() {}
    });
    let mut pool = HashMap::new();
    pool.insert("conv\u{1}ryu\u{1}spawn-old".to_owned(), pooled);

    let outcome =
        retire_superseded_instances(&mut pool, "conv", "ryu", "conv\u{1}ryu\u{1}spawn-new");
    assert_eq!(
        outcome,
        SupersededInstances {
            retired: 1,
            released_slot: true,
            changed: vec!["spawn_cmd"],
        }
    );
    let replacement = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        crate::acp_runtime::acquire_after_retiring(|_| {
            panic!("the replacement must not evict another chat's instance")
        }),
    )
    .await
    .expect("the retired instance's slot goes to the replacement");
    instance.await.expect("instance task");
    drop(replacement);
    apply_test_config(&serde_json::json!({}));
}

/// A turn queued behind a busy instance is admitted as soon as that
/// instance goes idle, not when its idle TTL expires.
#[tokio::test]
async fn an_instance_going_idle_wakes_a_queued_turn() {
    use crate::acp_runtime::tests::{apply_test_config, ADMISSION_TEST_LOCK};
    let _serial = ADMISSION_TEST_LOCK.lock().await;
    apply_test_config(&serde_json::json!({ "max_parallel_agents": 1 }));

    let mut permit = crate::acp_runtime::acquire(|_| false).await;
    let activity = AcpInstanceActivity::new();
    permit.track_eviction(activity.evicted.clone());
    activity.mark_admitted();
    activity.mark_busy();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let holder = tokio::spawn(async move {
        let _permit = permit;
        let _ = release_rx.await;
    });
    let waiter = tokio::spawn({
        let activity = std::sync::Arc::clone(&activity);
        let mut release_tx = Some(release_tx);
        async move {
            crate::acp_runtime::acquire(move |_| {
                if activity.idle_since().is_none() {
                    return false;
                }
                let Some(release) = release_tx.take() else {
                    return false;
                };
                assert!(crate::acp_runtime::start_eviction(&activity.evicted));
                let _ = release.send(());
                true
            })
            .await
        }
    });

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        !waiter.is_finished(),
        "the turn queues behind a busy instance"
    );
    activity.mark_idle();
    let admitted = tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
        .await
        .expect("going idle wakes the queued turn")
        .expect("waiter task");
    holder.await.expect("holder task");
    drop(admitted);
    apply_test_config(&serde_json::json!({}));
}
